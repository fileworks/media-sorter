"""Duplicate review, validation, and quarantine-management routes.

Every mutating request goes through :class:`ReviewPlan`, which is the one place
that refuses an action for a protected reference. That refusal is therefore a
property of the system rather than of this router: a handcrafted request reaches
the same guard the UI does.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.core.config_fingerprint import config_fingerprint
from app.core.duplicate_plans import BulkImpact, DecisionAction
from app.core.library_profiles import CatalogPlacement
from app.core.paths import resolve_app_paths
from app.services.catalog import MediaCatalog
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.catalog_location import open_catalog
from app.services.catalog_views import CursorError, ViewQuery, aggregate, query_page
from app.services.duplicate_grouping import exact_groups, similar_groups
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

#: Plans live for the life of the process and are persisted on every edit, so a
#: crash costs nothing a reload cannot restore.
_PLANS: dict[str, ReviewPlan] = {}


def _plans_directory() -> Path:
    return resolve_app_paths().data_dir / PLANS_DIRECTORY_NAME


def _plan(plan_id: str, *, transfer_mode: str = "copy") -> ReviewPlan:
    plan = _PLANS.get(plan_id)
    if plan is not None:
        return plan
    path = _plans_directory() / f"{plan_id}.json"
    plan = ReviewPlan.load(path) if path.is_file() else ReviewPlan(plan_id=plan_id)
    plan.transfer_mode = transfer_mode  # type: ignore[assignment]
    _PLANS[plan_id] = plan
    return plan


def _catalog(container: Any) -> MediaCatalog:
    profile = getattr(container.config, "library_profile", None)
    placement = getattr(profile, "catalog", None) or CatalogPlacement()
    if placement.mode != "application_data":
        placement = CatalogPlacement()
    return open_catalog(placement, data_dir=resolve_app_paths().data_dir)


# --------------------------------------------------------------------------- #
# Groups                                                                       #
# --------------------------------------------------------------------------- #


class GroupPage(BaseModel):
    groups: list[dict[str, Any]]
    next_cursor: str | None = None
    kind: str


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
    if fingerprint != config_fingerprint(config):
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
    kind: str = Query(default="exact", pattern="^(exact|similar)$"),
    limit: int = Query(default=50, ge=1, le=500),
    max_distance: int = Query(default=2, ge=0, le=16),
) -> GroupPage:
    """A bounded page of groups; members come with them but the library does not."""
    return await asyncio.to_thread(_list_groups, container, kind, limit, max_distance)


def _list_groups(container: Any, kind: str, limit: int, max_distance: int) -> GroupPage:
    with _catalog(container) as catalog:
        index = CatalogDuplicateIndex(catalog)
        if kind == "exact":
            produced = list(exact_groups(catalog, index, limit=limit))
        else:
            produced = list(similar_groups(catalog, index, max_distance=max_distance, limit=limit))
    return GroupPage(
        groups=[group.model_dump(mode="json") for group in produced],
        kind=kind,
    )


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
    plan = _plan(body.plan_id, transfer_mode=_transfer_mode(container))
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
    plan = _plan(body.plan_id, transfer_mode=_transfer_mode(container))
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
async def undo(body: UndoRequest) -> dict[str, Any]:
    plan = _plan(body.plan_id)
    try:
        result = plan.undo_last(body.group_id)
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await asyncio.to_thread(plan.save, _plans_directory())
    return result.model_dump(mode="json")


class PolicyRequest(BaseModel):
    plan_id: str = "default"
    group_ids: list[str] = Field(default_factory=list)
    policy_id: str = "largest"
    preferred_roots: list[str] = Field(default_factory=list)
    scope: str = Field(default="selected_groups")
    filter_key: str = ""


@router.post("/review/policy/preview", response_model=dict)
async def preview_policy(body: PolicyRequest, container: ContainerDep) -> dict[str, Any]:
    """What a bulk policy would touch, frozen against the current scope."""
    plan = _plan(body.plan_id, transfer_mode=_transfer_mode(container))
    await _ensure_groups(plan, container)
    impact = plan.preview_bulk(
        body.scope,  # type: ignore[arg-type]
        group_ids=body.group_ids,
        filter_key=body.filter_key,
    )
    return impact.model_dump(mode="json")


class ApplyPolicyRequest(PolicyRequest):
    impact: dict[str, Any]


@router.post("/review/policy/apply")
async def apply_policy_route(body: ApplyPolicyRequest, container: ContainerDep) -> dict[str, Any]:
    """Apply a previewed policy, refusing a scope that moved since the preview."""
    plan = _plan(body.plan_id, transfer_mode=_transfer_mode(container))
    await _ensure_groups(plan, container)
    settings = PolicySettings(
        policy_id=body.policy_id,  # type: ignore[arg-type]
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
    plan = _plan(body.plan_id, transfer_mode=_transfer_mode(container))
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


def _current_groups(container: Any) -> list[Any]:
    with _catalog(container) as catalog:
        index = CatalogDuplicateIndex(catalog)
        return list(exact_groups(catalog, index))


async def _ensure_groups(plan: ReviewPlan, container: Any) -> None:
    if plan.known_groups:
        return
    for group in await asyncio.to_thread(_current_groups, container):
        plan.register(group)


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
