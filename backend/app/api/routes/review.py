"""Duplicate review, validation, and quarantine-management routes.

Every mutating request goes through :class:`ReviewPlan`, which is the one place
that refuses an action for a protected reference. That refusal is therefore a
property of the system rather than of this router: a handcrafted request reaches
the same guard the UI does.
"""

from __future__ import annotations

import asyncio
import json
from itertools import chain
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.core.config_fingerprint import config_fingerprint
from app.core.duplicate_plans import BulkImpact, BulkScopeId, DecisionAction, DuplicateGroup
from app.core.logging_config import get_logger
from app.core.paths import resolve_app_paths
from app.core.run_scope import apply_run_scope
from app.services.catalog import MediaCatalog
from app.services.catalog_duplicates import (
    IMAGE_SIGNATURE_KIND,
    VIDEO_MAX_DISTANCE,
    VIDEO_SIGNATURE_KIND,
    CatalogDuplicateIndex,
)
from app.services.catalog_location import (
    live_catalog_generation,
    open_configured_catalog,
)
from app.services.catalog_views import (
    CursorError,
    ViewQuery,
    aggregate,
    decode_cursor,
    encode_cursor,
    query_page,
)
from app.services.duplicate_grouping import burst_groups, exact_groups, similar_groups
from app.services.keeper_policies import (
    HighConfidenceRule,
    PolicySettings,
    apply_policy,
    preview_rule,
)
from app.services.library_validators import ValidatorContext, run_validation
from app.services.quarantine import (
    CleanupRefused,
    permanently_remove,
    preview_cleanup,
    store_for_state_root,
)
from app.services.review_plan import (
    PLANS_DIRECTORY_NAME,
    PlanError,
    ReferenceImmutableError,
    ReviewPlan,
)

router = APIRouter()
logger = get_logger(__name__)

#: The perceptual distance the listing endpoint defaults to. The plan registers
#: similar groups at the same distance, so a stack a user can see is a stack the
#: plan has heard of.
DEFAULT_SIMILAR_DISTANCE = 2

#: Plans live for the life of the process and are persisted on every edit, so a
#: crash costs nothing a reload cannot restore.
_PLANS: dict[str, ReviewPlan] = {}


def _plans_directory() -> Path:
    return resolve_app_paths().data_dir / PLANS_DIRECTORY_NAME


def _plan(
    plan_id: str,
    *,
    transfer_mode: str = "copy",
    catalog_generation: int | None = None,
) -> ReviewPlan:
    """The plan for this id, discarded if it describes an older catalog.

    A plan holds group ids that only mean anything against the generation they
    were computed from. Carrying them past a rescan is what made every
    per-group route 404 for the rest of the process's life, and what let a
    stored ``default.json`` outlive the catalog it described.
    """
    plan = _PLANS.get(plan_id)
    if plan is not None:
        if catalog_generation is None or plan.catalog_generation == catalog_generation:
            return plan
        del _PLANS[plan_id]
    if plan is None:
        path = _plans_directory() / f"{plan_id}.json"
        plan = ReviewPlan.load(path) if path.is_file() else ReviewPlan(plan_id=plan_id)
    if catalog_generation is not None and plan.catalog_generation != catalog_generation:
        plan = ReviewPlan(plan_id=plan_id, catalog_generation=catalog_generation)
    plan.transfer_mode = transfer_mode  # type: ignore[assignment]
    _PLANS[plan_id] = plan
    return plan


async def _active_plan(
    plan_id: str,
    container: Any,
    *,
    transfer_mode: str = "copy",
) -> ReviewPlan:
    """Resolve a plan against the catalog generation that is live right now."""
    generation = await asyncio.to_thread(_live_generation, container)
    return _plan(plan_id, transfer_mode=transfer_mode, catalog_generation=generation)


def _catalog(container: Any) -> MediaCatalog:
    # One definition, shared with the sort route's freshness check (C-04).
    return open_configured_catalog(container)


# --------------------------------------------------------------------------- #
# Groups                                                                       #
# --------------------------------------------------------------------------- #


class GroupPage(BaseModel):
    groups: list[dict[str, Any]]
    next_cursor: str | None = None
    kind: str
    #: There are more groups than this page holds. A page that ends because the
    #: limit was reached looks exactly like one that ends because the library
    #: ran out, and a review surface that cannot tell them apart tells the user
    #: they are finished when they are not.
    truncated: bool = False
    #: A root's newest finished scan stopped short of everything it was asked to
    #: read. The sets below may be missing members, which is the one thing
    #: somebody about to quarantine a file needs to know before they trust them.
    partial_index: bool = False


class OutcomeRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=500)


@router.post("/review/outcomes")
async def review_outcomes(
    body: OutcomeRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> dict[str, Any]:
    """Expose the recorded resolved date and candidates to Review surfaces."""
    fingerprint, outcomes = container.preview_service.latest_outcomes(body.paths)
    if fingerprint is None:
        raise HTTPException(status_code=404, detail="No completed preview is available")
    scoped = apply_run_scope(config, container.preview_service.latest_excluded_root_ids)
    if fingerprint != config_fingerprint(scoped.config):
        raise HTTPException(
            status_code=409,
            detail="Configuration changed after preview; generate it again",
        )
    return {
        "config_fingerprint": fingerprint,
        "outcomes": outcomes,
        "unavailable_paths": [
            path for path in body.paths if all(item["source"] != path for item in outcomes)
        ],
    }


@router.get("/review/groups", response_model=GroupPage)
async def list_groups(
    container: ContainerDep,
    config: ConfigDep,
    kind: str = Query(default="exact", pattern="^(exact|similar|burst)$"),
    limit: int = Query(default=50, ge=1, le=500),
    max_distance: int = Query(default=DEFAULT_SIMILAR_DISTANCE, ge=0, le=16),
    excluded_roots: Annotated[list[str] | None, Query()] = None,
    cursor: str | None = Query(default=None),
) -> GroupPage:
    """A bounded page of groups; members come with them but the library does not.

    Three kinds, one shape. A burst is not a second concept with its own
    endpoints and its own decision vocabulary — it is a stack whose evidence
    happens to include capture time and camera, and it resolves through the same
    ``/review/decide`` and ``/review/policy/*`` routes as the other two.
    """
    try:
        return await asyncio.to_thread(
            _list_groups,
            container,
            config,
            kind,
            limit,
            max_distance,
            excluded_roots or [],
            cursor,
        )
    except CursorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _list_groups(
    container: Any,
    config: Any,
    kind: str,
    limit: int,
    max_distance: int,
    excluded_roots: list[str],
    cursor: str | None = None,
) -> GroupPage:
    excluded_ids = frozenset(apply_run_scope(config, excluded_roots).excluded_root_ids)
    identity = _group_query_identity(kind, max_distance, excluded_ids)
    with _catalog(container) as catalog:
        index = CatalogDuplicateIndex(catalog)
        generation = catalog.current_generation()
        if kind == "exact":
            produced = exact_groups(catalog, index, generation=generation)
        elif kind == "burst":
            produced = burst_groups(
                catalog,
                index,
                time_window_seconds=config.burst_time_window_seconds,
                max_perceptual_distance=config.burst_perceptual_distance,
                require_camera_identity=config.burst_require_camera_identity,
                generation=generation,
            )
        else:
            # Images and videos are two passes, not one. Their signatures have
            # different widths and need different thresholds, so a single query
            # would either miss every video re-encode or loosen image matching
            # to a threshold no photograph should be judged at.
            produced = chain(
                similar_groups(
                    catalog,
                    index,
                    max_distance=max_distance,
                    kind=IMAGE_SIGNATURE_KIND,
                    generation=generation,
                ),
                similar_groups(
                    catalog,
                    index,
                    max_distance=VIDEO_MAX_DISTANCE,
                    kind=VIDEO_SIGNATURE_KIND,
                    generation=generation,
                ),
            )
        after = _resume_after(cursor, identity=identity, generation=generation)
        scoped_groups, truncated = _take_scoped_groups(produced, excluded_ids, limit, after=after)
        partial_index = catalog.has_partial_generation()
    if kind == "burst" and getattr(config, "burst_detection_enabled", False):
        for group in scoped_groups:
            try:
                container.burst_detection_service.issue_review_group(group)
            except (OSError, ValueError) as exc:
                # Listing remains observational, while the destructive endpoint
                # stays fail-closed because no issued identity is registered.
                logger.warning(
                    "review.burst_group_not_issued",
                    group_id=group.group_id,
                    error=str(exc),
                )
    next_cursor = (
        encode_cursor({"q": identity, "g": generation, "id": scoped_groups[-1].group_id})
        if truncated and scoped_groups
        else None
    )
    return GroupPage(
        groups=[group.model_dump(mode="json") for group in scoped_groups],
        kind=kind,
        next_cursor=next_cursor,
        truncated=truncated,
        partial_index=partial_index,
    )


def _group_query_identity(kind: str, max_distance: int, excluded_ids: frozenset[str]) -> str:
    """Two group queries with the same identity may share a cursor; others may not.

    `max_distance` is part of it for every kind, not only `similar`: a cursor
    that survived a threshold change would resume a list that no longer exists.
    """
    return json.dumps(
        {"kind": kind, "max_distance": max_distance, "excluded": sorted(excluded_ids)},
        sort_keys=True,
    )


def _resume_after(cursor: str | None, *, identity: str, generation: int) -> str | None:
    """The group id this page continues after, or None to start at the top."""
    if not cursor:
        return None
    decoded = decode_cursor(cursor)
    if decoded.get("q") != identity:
        raise CursorError("this page marker belongs to a different list")
    if decoded.get("g") != generation:
        # The library was re-indexed under the reader. Resuming would page
        # through a list that no longer exists, so the caller starts over
        # rather than being handed a plausible-looking wrong page.
        raise CursorError("the catalog changed since this page marker was made")
    resume = decoded.get("id")
    return str(resume) if resume else None


def _take_scoped_groups(
    groups: Any,
    excluded_root_ids: frozenset[str],
    limit: int,
    *,
    after: str | None = None,
) -> tuple[list[DuplicateGroup], bool]:
    """Drop excluded-root members before they can influence a review decision.

    Returns the page and whether more groups follow it. Truncation is detected
    by taking one group past the limit and dropping it, so "the page is full"
    and "the library ended" stop looking identical.

    Resumption re-runs the producer and skips to *after*. The producers are
    deterministic over an unchanged catalog, so the continuation is exact — no
    group appears twice and none is skipped. It costs a re-scan of the pages
    already read, which is the price of not holding per-reader state on a
    surface that a person pages through a few times.
    """
    selected: list[DuplicateGroup] = []
    truncated = False
    resuming = after is not None
    for group in groups:
        if resuming:
            if group.group_id == after:
                resuming = False
            continue
        members = tuple(
            member for member in group.members if member.root_id not in excluded_root_ids
        )
        if len(members) < 2:
            continue
        anchor = group.anchor_member_id
        if anchor is not None and all(member.member_id != anchor for member in members):
            anchor = members[0].member_id
        selected.append(
            group.model_copy(
                update={
                    "members": members,
                    "member_count": len(members),
                    "total_bytes": sum(member.facts.size_bytes for member in members),
                    "anchor_member_id": anchor,
                }
            )
        )
        if len(selected) > limit:
            selected.pop()
            truncated = True
            break
    return selected, truncated


# --------------------------------------------------------------------------- #
# Plan editing                                                                 #
# --------------------------------------------------------------------------- #


class DecisionRequest(BaseModel):
    plan_id: str = Field(default="default", min_length=1, max_length=128)
    group_id: str = Field(min_length=1)
    member_id: str = Field(min_length=1)
    action: DecisionAction
    reason: str = ""


@router.post("/review/decide")
async def decide(body: DecisionRequest, container: ContainerDep) -> dict[str, Any]:
    """Record one decision. A reference member is refused here, not later."""
    plan = await _active_plan(body.plan_id, container, transfer_mode=_transfer_mode(container))
    await _ensure_group(plan, container, body.group_id)
    try:
        result = plan.decide(body.group_id, body.member_id, body.action, reason=body.reason)
    except ReferenceImmutableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return result.model_dump(mode="json")


class AllExceptRequest(BaseModel):
    plan_id: str = "default"
    group_id: str
    keep_member_ids: list[str] = Field(default_factory=list)


@router.post("/review/quarantine-all-except")
async def quarantine_all_except(body: AllExceptRequest, container: ContainerDep) -> dict[str, Any]:
    plan = await _active_plan(body.plan_id, container, transfer_mode=_transfer_mode(container))
    await _ensure_group(plan, container, body.group_id)
    try:
        result = plan.quarantine_all_except(body.group_id, body.keep_member_ids)
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return result.model_dump(mode="json")


class UndoRequest(BaseModel):
    plan_id: str = "default"
    group_id: str


@router.post("/review/undo")
async def undo(body: UndoRequest, container: ContainerDep) -> dict[str, Any]:
    plan = await _active_plan(body.plan_id, container)
    try:
        result = plan.undo_last(body.group_id)
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return result.model_dump(mode="json")


class PolicyRequest(BaseModel):
    plan_id: str = "default"
    group_ids: list[str] = Field(default_factory=list)
    # Omitted means "use the configured default keep rule", so a caller that
    # does not care never has to restate the user's own preference.
    policy_id: str | None = None
    preferred_roots: list[str] = Field(default_factory=list)
    # Typed here rather than as a bare string: an unrecognised scope used to
    # reach `BulkImpact`, whose own validator rejected it *after* the work had
    # started, and the caller got a 500 with a traceback instead of a 422
    # naming the four scopes that exist.
    scope: BulkScopeId = "selected_groups"
    filter_key: str = ""


@router.post("/review/policy/preview", response_model=dict)
async def preview_policy(body: PolicyRequest, container: ContainerDep) -> dict[str, Any]:
    """What a bulk policy would touch, frozen against the current scope."""
    plan = await _active_plan(body.plan_id, container, transfer_mode=_transfer_mode(container))
    await _ensure_groups(plan, container)
    try:
        impact = plan.preview_bulk(
            body.scope,
            group_ids=body.group_ids,
            filter_key=body.filter_key,
        )
    except PlanError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return impact.model_dump(mode="json")


class ApplyPolicyRequest(PolicyRequest):
    impact: dict[str, Any]


@router.post("/review/policy/apply")
async def apply_policy_route(body: ApplyPolicyRequest, container: ContainerDep) -> dict[str, Any]:
    """Apply a previewed policy, refusing a scope that moved since the preview."""
    plan = await _active_plan(body.plan_id, container, transfer_mode=_transfer_mode(container))
    await _ensure_groups(plan, container)
    settings = PolicySettings(
        policy_id=_policy_id(body, container),  # type: ignore[arg-type]
        preferred_roots=tuple(body.preferred_roots),
    )

    def applier(active: ReviewPlan, group: Any) -> bool:
        result = apply_policy(group, settings)
        if not result.decided:
            return False
        for decision in result.decisions:
            try:
                active.decide(
                    group.group_id,
                    decision.member_id,
                    decision.action,
                    source="policy",
                    reason=decision.reason,
                )
            except ReferenceImmutableError:
                continue
        return True

    try:
        applied = plan.apply_bulk(
            BulkImpact.model_validate(body.impact),
            applier,
            group_ids=body.group_ids,
            filter_key=body.filter_key,
        )
    except PlanError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return {"applied_groups": applied}


class SimilarRuleRequest(BaseModel):
    max_distance: int = Field(default=0, ge=0, le=16)
    require_same_dimensions: bool = True
    require_same_media_kind: bool = True
    limit: int = Field(default=200, ge=1, le=1000)


@router.post("/review/similar-rule/preview")
async def preview_similar_rule(body: SimilarRuleRequest, container: ContainerDep) -> dict[str, Any]:
    """What enabling the high-confidence rule would affect, before consent."""
    rule = HighConfidenceRule(
        max_distance=body.max_distance,
        require_same_dimensions=body.require_same_dimensions,
        require_same_media_kind=body.require_same_media_kind,
    )

    def compute() -> dict[str, Any]:
        with _catalog(container) as catalog:
            index = CatalogDuplicateIndex(catalog)
            groups = list(
                similar_groups(
                    catalog, index, max_distance=max(body.max_distance, 1), limit=body.limit
                )
            )
        proposals = preview_rule(groups, rule)
        applying = [item for item in proposals if item.applies]
        return {
            "groups_considered": len(groups),
            "groups_affected": len(applying),
            "members_quarantined": sum(item.affected_members for item in applying),
            "quarantine_only": True,
            "proposals": [
                {
                    "group_id": item.group_id,
                    "applies": item.applies,
                    "reason": item.reason,
                    "members": item.affected_members,
                }
                for item in proposals
            ],
        }

    return await asyncio.to_thread(compute)


# --------------------------------------------------------------------------- #
# Execution boundary                                                           #
# --------------------------------------------------------------------------- #


class SnapshotRequest(BaseModel):
    plan_id: str = "default"
    acknowledge_source_mutations: bool = False


@router.post("/review/snapshot")
async def snapshot(body: SnapshotRequest, container: ContainerDep) -> dict[str, Any]:
    """Freeze the reviewed plan, after re-checking it against the catalog."""
    plan = await _active_plan(body.plan_id, container, transfer_mode=_transfer_mode(container))
    current = await asyncio.to_thread(_current_groups, container)
    stale = plan.mark_stale(plan.detect_drift(current))
    try:
        frozen = plan.snapshot(acknowledge_source_mutations=body.acknowledge_source_mutations)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return {
        "snapshot": frozen.model_dump(mode="json"),
        "stale_groups": sorted(stale),
    }


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #


@router.get("/review/validation")
async def validation(
    container: ContainerDep,
    root_id: str = Query(min_length=1),
    checks: str | None = Query(default=None, description="Comma-separated validator ids"),
) -> dict[str, Any]:
    """Run the enabled validators over one root and report what they found."""

    def run() -> dict[str, Any]:
        with _catalog(container) as catalog:
            context = ValidatorContext(
                catalog=catalog,
                root_id=root_id,
                duplicate_index=CatalogDuplicateIndex(catalog),
            )
            report = run_validation(
                context,
                enabled=None if checks is None else [item.strip() for item in checks.split(",")],
            )
        return report.model_dump(mode="json")

    return await asyncio.to_thread(run)


# --------------------------------------------------------------------------- #
# Quarantine cleanup                                                           #
# --------------------------------------------------------------------------- #


class CleanupRequest(BaseModel):
    record_ids: list[str] = Field(min_length=1)
    acknowledge_permanent_deletion: bool = False


@router.post("/quarantine/cleanup/preview")
async def cleanup_preview(body: CleanupRequest) -> dict[str, Any]:
    """Freeze exactly what permanent removal would destroy."""
    store = store_for_state_root(resolve_app_paths().data_dir)
    impact = await asyncio.to_thread(preview_cleanup, store, body.record_ids)
    return {
        "record_ids": list(impact.record_ids),
        "item_count": impact.item_count,
        "total_bytes": impact.total_bytes,
        "excluded_reasons": list(impact.excluded_reasons),
        "acknowledgement_text": impact.acknowledgement_text,
    }


@router.post("/quarantine/cleanup")
async def cleanup(body: CleanupRequest) -> dict[str, Any]:
    """Permanently remove quarantined files. Separate, journalled, and final."""
    store = store_for_state_root(resolve_app_paths().data_dir)
    impact = await asyncio.to_thread(preview_cleanup, store, body.record_ids)
    try:
        outcome = await asyncio.to_thread(
            permanently_remove,
            store,
            impact,
            acknowledged=body.acknowledge_permanent_deletion,
        )
    except CleanupRefused as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "code": outcome.code,
        "removed": list(outcome.removed),
        "failed": [{"record_id": rid, "reason": reason} for rid, reason in outcome.failed],
        "bytes_removed": outcome.bytes_removed,
    }


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def _transfer_mode(container: Any) -> str:
    profile = getattr(container.config, "library_profile", None)
    return str(getattr(profile, "transfer_mode", None) or "copy")


def _policy_id(body: PolicyRequest, container: Any) -> str:
    """The requested keep rule, or the configured default when none was sent."""
    if body.policy_id:
        return body.policy_id
    return str(getattr(container.config, "duplicate_keeper_policy", None) or "newest")


def _live_generation(container: Any) -> int:
    return live_catalog_generation(container)


def _current_groups(container: Any) -> list[Any]:
    """Every stack Review can show, so every one of them can be decided.

    All three kinds are registered, not only the exact ones. A plan that knows
    a group is what makes ``/review/decide`` and the policy routes work on it;
    a stack the surface renders but the plan has never heard of answers 404 to
    every action taken on it.
    """
    config = container.config
    with _catalog(container) as catalog:
        index = CatalogDuplicateIndex(catalog)
        generation = catalog.current_generation()
        groups = list(exact_groups(catalog, index, generation=generation))
        groups.extend(
            similar_groups(
                catalog,
                index,
                max_distance=DEFAULT_SIMILAR_DISTANCE,
                generation=generation,
            )
        )
        if getattr(config, "burst_detection_enabled", False):
            groups.extend(
                burst_groups(
                    catalog,
                    index,
                    time_window_seconds=config.burst_time_window_seconds,
                    max_perceptual_distance=config.burst_perceptual_distance,
                    require_camera_identity=config.burst_require_camera_identity,
                    generation=generation,
                )
            )
        return groups


async def _ensure_groups(plan: ReviewPlan, container: Any) -> None:
    """Hold the groups of the current generation, and only those.

    The generation is a cheap lookup; rebuilding the groups is not, so the
    expensive half runs only when the plan is empty or genuinely out of date.
    """
    generation = await asyncio.to_thread(_live_generation, container)
    if plan.known_groups and plan.catalog_generation == generation:
        return
    groups = await asyncio.to_thread(_current_groups, container)
    plan.known_groups = {}
    plan.catalog_generation = generation
    for group in groups:
        plan.register(group)
    # Decisions about groups this generation no longer has are not recoverable
    # and must not reach a snapshot.
    for group_id in set(plan.groups) - set(plan.known_groups):
        del plan.groups[group_id]


async def _ensure_group(plan: ReviewPlan, container: Any, group_id: str) -> None:
    if group_id in plan.known_groups:
        return
    await _ensure_groups(plan, container)
    if group_id not in plan.known_groups:
        raise HTTPException(status_code=404, detail="No such group in the current results")


# --------------------------------------------------------------------------- #
# Catalog-backed list views                                                    #
# --------------------------------------------------------------------------- #


class ViewPageResponse(BaseModel):
    """One page of a list, plus the marker for the next one."""

    rows: list[dict[str, Any]]
    next_cursor: str | None
    generation: int
    total_rows: int
    total_bytes: int


@router.get("/review/view", response_model=ViewPageResponse)
async def list_view(
    container: ContainerDep,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    roles: str = Query(default="input,destination,reference"),
    sort: str = Query(default="path", pattern="^(path|size|modified)$"),
    descending: bool = Query(default=False),
    search: str = Query(default="", max_length=200),
    include_totals: bool = Query(default=True),
) -> ViewPageResponse:
    """A bounded page of the library, read from the catalog by indexed cursor.

    The totals come from the same filter as the rows, so a header can never
    describe a different set than the list under it.
    """

    def read() -> ViewPageResponse:
        query = ViewQuery(
            roles=tuple(role.strip() for role in roles.split(",") if role.strip()),
            sort=sort,  # type: ignore[arg-type]
            descending=descending,
            search=search,
        )
        with _catalog(container) as catalog:
            try:
                page = query_page(catalog, query, cursor=cursor, page_size=limit)
            except CursorError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            totals = aggregate(catalog, query) if include_totals else None
        return ViewPageResponse(
            rows=[row.to_dict() for row in page.rows],
            next_cursor=page.next_cursor,
            generation=page.generation,
            total_rows=totals.total_rows if totals else len(page.rows),
            total_bytes=totals.total_bytes if totals else 0,
        )

    return await asyncio.to_thread(read)
