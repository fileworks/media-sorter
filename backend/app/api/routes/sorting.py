"""Sorting routes — start, status, cancel, and report."""

import asyncio
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel, Field, JsonValue, ValidationError, model_validator

from app.api.deps import ContainerDep
from app.api.schemas import (
    TaskCancelResponse,
    TaskProgressResponse,
    TaskStartRequest,
    TaskStartResponse,
)
from app.core.config_fingerprint import config_fingerprint
from app.core.exceptions import ConflictError, TaskNotFoundError
from app.core.filesystem_capabilities import (
    FilesystemCapabilityReport,
    probe_filesystem_capabilities,
)
from app.core.logging_config import get_logger
from app.core.paths import resolve_app_paths
from app.core.plan_store import (
    InvalidPlanStoreError,
    PlanExpiredError,
    PlanStoreError,
    UnsupportedPlanStoreVersionError,
)
from app.core.run_scope import apply_run_scope
from app.core.sort_plan import (
    FrozenSortImpact,
    ReviewedSet,
    destination_fingerprint,
    source_fingerprint,
)
from app.services.catalog_location import live_catalog_generation
from app.services.quarantine import PreflightResult, preflight, store_for_state_root

logger = get_logger(__name__)
router = APIRouter()


def _capability_degradations(report: FilesystemCapabilityReport) -> list[str]:
    """What this destination cannot preserve, named once.

    `C-11`. The probe existed and nothing called it, so a run onto exFAT or an
    SMB share discovered each limitation one file at a time — as a per-file
    warning repeated for every photograph, which is how a real signal becomes
    noise a person scrolls past.

    Only `unsupported` counts. `permission_denied` and `unknown` are the probe
    saying it could not find out, and reporting those as lost capabilities would
    warn about a destination that is probably fine.
    """
    observations: list[tuple[str, str]] = [
        (report.timestamp.status, "modification times are not preserved"),
        (report.permissions.status, "file permissions are not preserved"),
        (
            report.extended_attributes.status,
            "extended attributes (tags, Finder comments) are not preserved",
        ),
        (
            report.atomic_replace.status,
            "atomic replace is unavailable, so an interrupted write is riskier",
        ),
        (report.symlinks.status, "symbolic links cannot be created"),
    ]
    return [detail for status, detail in observations if status == "unsupported"]


def _space_preflight(target_directory: str, impact: FrozenSortImpact) -> PreflightResult:
    """Budget one run against every volume it would actually write to.

    Two different devices are involved and the plan's own totals do not say so:

    * the **destination** receives copies, the converted outputs, and the
      `_duplicates`/`_corrupted` folders — `quarantine_dir()` builds those under
      the destination root, so they always share its volume;
    * the **quarantine store** receives the originals conversion replaced, and
      it lives under the app data directory (`state_root`), which on a NAS or
      external-drive destination is a different device entirely.

    `estimated_converted_bytes` is charged twice on purpose: once at the
    destination for the file conversion writes, once in the store for the
    original it sets aside. Both exist at the same moment, which is exactly when
    the run can run out of room.
    """
    quarantine_root = store_for_state_root(resolve_app_paths().data_dir).root
    return preflight(
        destination_bytes=(
            impact.required_bytes + impact.quarantine_bytes + impact.estimated_converted_bytes
        ),
        quarantine_bytes=impact.estimated_converted_bytes,
        destination=Path(target_directory),
        quarantine_root=quarantine_root,
    )


class StartSortRequest(TaskStartRequest):
    dry_run: bool = False
    expected_config_fingerprint: str | None = None
    plan_id: str | None = None
    #: Configured input/reference roots the Sources stage omitted from this run.
    excluded_roots: list[str] = Field(default_factory=list)
    #: The duplicate sets Review decided, and which copy it chose. Applied to
    #: the derived plan, so one run's overrides do not follow the stored plan
    #: around. Replaces `reviewed_keepers`, which could name a winner but not
    #: the losers whose planned actions have to change with it.
    reviewed_sets: list[ReviewedSet] = Field(default_factory=list)


class PlanImpactRequest(TaskStartRequest):
    """The decisions a run would carry, so its impact can be described."""

    plan_id: str
    excluded_roots: list[str] = Field(default_factory=list)
    reviewed_sets: list[ReviewedSet] = Field(default_factory=list)


ReviewSetId = Annotated[str, Field(min_length=1, max_length=512)]


class ReviewDecisionState(BaseModel):
    group_id: ReviewSetId
    kind: Literal["keeper", "keep_all"]
    member_id: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def validate_member(self) -> "ReviewDecisionState":
        if self.kind == "keeper" and not self.member_id:
            raise ValueError("a keeper decision requires member_id")
        if self.kind == "keep_all" and self.member_id is not None:
            raise ValueError("a keep-all decision cannot name member_id")
        return self


class PlanReviewState(BaseModel):
    """Durable UI state attached to one exact frozen plan."""

    schema_version: Literal[1] = 1
    config_fingerprint: str = Field(min_length=1)
    decisions: list[ReviewDecisionState] = Field(default_factory=list, max_length=100_000)
    selected_set_ids: list[ReviewSetId] = Field(default_factory=list, max_length=100_000)
    mode: Literal["browse", "resolve"]
    queue_set_id: str | None = Field(default=None, max_length=512)
    detail_path: str | None = Field(default=None, max_length=4096)
    viewer_path: str | None = Field(default=None, max_length=4096)
    search: str = Field(max_length=4096)
    tree_path: str | None = Field(default=None, max_length=4096)
    view: Literal["list", "grid"]
    sort: Literal["name", "size", "date"]
    keep_policy: Literal[
        "smart",
        "best_quality",
        "newest",
        "oldest",
        "largest",
        "smallest",
        "highest_resolution",
        "longest_filename",
        "shortest_filename",
        "manual",
    ]

    @model_validator(mode="after")
    def validate_unique_sets(self) -> "PlanReviewState":
        decision_ids = [decision.group_id for decision in self.decisions]
        if len(decision_ids) != len(set(decision_ids)):
            raise ValueError("each duplicate set may have only one explicit decision")
        if len(self.selected_set_ids) != len(set(self.selected_set_ids)):
            raise ValueError("selected duplicate set ids must be unique")
        return self


class PlanRecoveryResponse(BaseModel):
    plan_id: str
    config_fingerprint: str
    destination_fingerprint: str
    source_fingerprints: dict[str, str]
    reviewed_sets: list[ReviewedSet]
    preview_result: dict[str, JsonValue]
    review_state: PlanReviewState | None


def _recover_plan(container: Any, plan_id: str) -> PlanRecoveryResponse:
    try:
        stored = container.preview_service.stored_plan(plan_id)
    except PlanExpiredError as exc:
        raise ConflictError(
            "The reviewed plan expired; generate preview again.",
            details={"reason": "expired_plan", "plan_id": plan_id},
        ) from exc
    except UnsupportedPlanStoreVersionError as exc:
        raise ConflictError(
            "A newer MediaSorter build wrote this reviewed plan.",
            details={"reason": "unsupported_plan", "plan_id": plan_id},
        ) from exc
    except InvalidPlanStoreError as exc:
        raise ConflictError(
            "The reviewed plan is no longer available; generate preview again.",
            details={"reason": "missing_plan", "plan_id": plan_id},
        ) from exc
    plan = stored.plan
    if stored.preview_result is None:
        raise ConflictError(
            "The reviewed plan has no durable Review snapshot; generate preview again.",
            details={"reason": "missing_review_snapshot", "plan_id": plan_id},
        )
    if (
        stored.preview_result.get("plan_id") != plan.plan_id
        or stored.preview_result.get("config_fingerprint") != plan.config_fingerprint
    ):
        raise ConflictError(
            "The durable Review snapshot does not belong to this frozen plan.",
            details={"reason": "stale_review_snapshot", "plan_id": plan_id},
        )
    current_config = config_fingerprint(container.config)
    if plan.config_fingerprint != current_config:
        raise ConflictError(
            "The reviewed plan is stale because configuration changed.",
            details={"reason": "stale_recovery", "plan_id": plan_id},
        )
    if plan.destination_fingerprint is None:
        raise ConflictError(
            "The reviewed plan has no complete destination evidence.",
            details={"reason": "stale_recovery", "plan_id": plan_id},
        )
    current_destination = destination_fingerprint(Path(container.config.target_directory))
    if current_destination != plan.destination_fingerprint:
        raise ConflictError(
            "The reviewed plan is stale because the destination changed.",
            details={"reason": "stale_recovery", "plan_id": plan_id},
        )
    fingerprints: dict[str, str] = {}
    for action in plan.actions:
        try:
            current = source_fingerprint(Path(action.source_path))
        except OSError as exc:
            raise ConflictError(
                "The reviewed plan is stale because a source is unavailable.",
                details={"reason": "stale_recovery", "plan_id": plan_id},
            ) from exc
        if current != action.source_fingerprint:
            raise ConflictError(
                "The reviewed plan is stale because a source changed.",
                details={"reason": "stale_recovery", "plan_id": plan_id},
            )
        fingerprints[action.source_path] = current
    try:
        review_state = (
            PlanReviewState.model_validate(stored.review_state)
            if stored.review_state is not None
            else None
        )
    except ValidationError as exc:
        raise ConflictError(
            "The durable Review state is invalid and cannot be recovered.",
            details={"reason": "invalid_review_state", "plan_id": plan_id},
        ) from exc
    if review_state is not None and review_state.config_fingerprint != plan.config_fingerprint:
        raise ConflictError(
            "The durable Review state belongs to a different configuration.",
            details={"reason": "stale_review_state", "plan_id": plan_id},
        )
    return PlanRecoveryResponse(
        plan_id=plan.plan_id,
        config_fingerprint=plan.config_fingerprint,
        destination_fingerprint=plan.destination_fingerprint,
        source_fingerprints=fingerprints,
        reviewed_sets=list(plan.reviewed_sets),
        preview_result=stored.preview_result,
        review_state=review_state,
    )


@router.get("/sorting/plans/{plan_id}/recovery", response_model=PlanRecoveryResponse)
async def recover_sort_plan(plan_id: str, container: ContainerDep) -> PlanRecoveryResponse:
    return await asyncio.to_thread(_recover_plan, container, plan_id)


@router.put(
    "/sorting/plans/{plan_id}/review-state",
    response_model=PlanReviewState,
)
async def save_plan_review_state(
    plan_id: str,
    body: PlanReviewState,
    container: ContainerDep,
) -> PlanReviewState:
    try:
        await asyncio.to_thread(
            container.preview_service.save_review_state,
            plan_id,
            body.model_dump(mode="json"),
            expected_config_fingerprint=body.config_fingerprint,
        )
    except PlanStoreError as exc:
        raise ConflictError(
            "Review state could not be persisted for this plan.",
            details={"reason": "review_state_not_persisted", "plan_id": plan_id},
        ) from exc
    return body


@router.post("/sorting/impact", response_model=FrozenSortImpact)
async def plan_impact(container: ContainerDep, body: PlanImpactRequest) -> FrozenSortImpact:
    """What a run carrying these duplicate decisions would actually do."""
    plan = container.preview_service.frozen_plan(body.plan_id)
    if plan is None:
        raise ConflictError(
            "The reviewed plan is no longer available; generate preview again.",
            details={"reason": "missing_plan", "plan_id": body.plan_id},
        )
    scoped = apply_run_scope(container.config, body.excluded_roots)
    if plan.config_fingerprint != config_fingerprint(scoped.config):
        raise ConflictError(
            "The source scope changed after preview; generate and review a new plan.",
            details={"reason": "stale_plan_scope", "plan_id": body.plan_id},
        )
    return plan.with_reviewed_sets(
        body.reviewed_sets,
        source_root=scoped.config.source_directory,
    ).impact


@router.post("/sorting/start", response_model=TaskStartResponse)
async def start_sorting(
    container: ContainerDep,
    body: StartSortRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or StartSortRequest()
    scope = apply_run_scope(container.config, request.excluded_roots)
    current_fingerprint = config_fingerprint(scope.config)
    if (
        request.expected_config_fingerprint is not None
        and request.expected_config_fingerprint != current_fingerprint
    ):
        raise ConflictError(
            "The configuration changed after preview; generate and review a new plan.",
            details={
                "reason": "stale_preview",
                "expected_config_fingerprint": request.expected_config_fingerprint,
                "current_config_fingerprint": current_fingerprint,
            },
        )
    frozen_plan = None
    # C-03: a mutating run must point at a plan somebody reviewed. `plan_id` was
    # optional, so a live start could omit it and proceed with no frozen plan at
    # all — no plan guard, no authorised effects, and no record of what the user
    # actually agreed to. Copy mutates the filesystem as surely as move does (it
    # writes destinations, converts, and rewrites metadata), so the requirement
    # is on `dry_run`, not on the transfer mode.
    if not request.dry_run and request.plan_id is None:
        raise ConflictError(
            "A live run needs a reviewed plan; generate a preview first.",
            details={"reason": "plan_required", "dry_run": False},
        )
    if request.plan_id is not None:
        frozen_plan = container.preview_service.frozen_plan(request.plan_id)
        if frozen_plan is None:
            raise ConflictError(
                "The reviewed plan is no longer available; generate preview again.",
                details={"reason": "missing_plan", "plan_id": request.plan_id},
            )
        if frozen_plan.config_fingerprint != current_fingerprint:
            raise ConflictError(
                "The configuration changed after preview; generate and review a new plan.",
                details={"reason": "stale_plan", "plan_id": request.plan_id},
            )
        # C-04: the destination is half of what a sort plan is about, and the
        # configuration fingerprint says nothing about it. A file that appeared
        # in the destination after the preview left the plan looking fresh, and
        # the run then failed that one file mid-execution with a per-file
        # `destination_exists` report — a whole run started on a plan already
        # known to be wrong. A plan recorded before this field existed carries
        # generation 0 and is not refused: refusing every older plan would be a
        # worse answer than the one defect this prevents.
        live_generation = await asyncio.to_thread(live_catalog_generation, container)
        if frozen_plan.catalog_generation and frozen_plan.catalog_generation != live_generation:
            raise ConflictError(
                "The destination changed after preview; generate and review a new plan.",
                details={
                    "reason": "stale_catalog",
                    "plan_id": request.plan_id,
                    "plan_catalog_generation": frozen_plan.catalog_generation,
                    "current_catalog_generation": live_generation,
                },
            )
        live_destination_fingerprint = await asyncio.to_thread(
            destination_fingerprint,
            Path(scope.config.target_directory),
        )
        if frozen_plan.destination_fingerprint is None:
            raise ConflictError(
                "The reviewed plan has no complete destination-freshness evidence; "
                "generate preview again.",
                details={"reason": "destination_evidence_missing", "plan_id": request.plan_id},
            )
        if frozen_plan.destination_fingerprint != live_destination_fingerprint:
            raise ConflictError(
                "The destination changed after preview; generate and review a new plan.",
                details={
                    "reason": "stale_destination",
                    "plan_id": request.plan_id,
                    "plan_destination_fingerprint": frozen_plan.destination_fingerprint,
                    "current_destination_fingerprint": live_destination_fingerprint,
                },
            )
        if request.reviewed_sets:
            frozen_plan = frozen_plan.with_reviewed_sets(
                request.reviewed_sets,
                source_root=scope.config.source_directory,
            )
        # C-07: `quarantine.preflight()` existed but nothing called it, so a run
        # whose destination could not hold it started anyway and failed part-way
        # through — the worst moment to discover it, because half the library
        # has already moved. Checked here, before any file is touched, and only
        # for a live run: a dry run writes nothing to budget for.
        if not request.dry_run:
            readiness = await asyncio.to_thread(
                _space_preflight, scope.config.target_directory, frozen_plan.impact
            )
            if not readiness.ready:
                raise ConflictError(
                    readiness.headline,
                    details={
                        "reason": "insufficient_space",
                        "plan_id": request.plan_id,
                        "blocked_reasons": list(readiness.blocked_reasons),
                        "volumes": [
                            {
                                "path": str(volume.path),
                                "required_bytes": volume.required_bytes,
                                "available_bytes": volume.available_bytes,
                            }
                            for volume in readiness.volumes
                        ],
                    },
                )
        # C-11: probe the destination once, before anything is written, and
        # state what it cannot preserve. One report per run, not one per file.
        capabilities = await asyncio.to_thread(
            probe_filesystem_capabilities, Path(scope.config.target_directory)
        )
        degradations = _capability_degradations(capabilities)
        if degradations:
            logger.warning(
                "destination.capabilities_degraded",
                destination=scope.config.target_directory,
                device_id=capabilities.device_id,
                degradations=degradations,
            )
    task, replayed = container.task_manager.start_task(
        "sort",
        request.idempotency_key,
        container.sorting_service.run,
        dry_run=request.dry_run,
        frozen_plan=frozen_plan,
        excluded_roots=request.excluded_roots,
    )
    if retry_attempt is not None:
        task.record_transport_retry(
            retry_attempt,
            timed_out=transport_event == "timeout",
        )
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/sorting/{task_id}", response_model=TaskProgressResponse)
async def get_sorting_progress(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskProgressResponse:
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    if retry_attempt is not None:
        task.record_transport_retry(
            retry_attempt,
            timed_out=transport_event == "timeout",
        )
    return TaskProgressResponse.from_task(task, after_sequence=after_sequence)


@router.post("/sorting/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_sorting(
    task_id: str,
    container: ContainerDep,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskCancelResponse:
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    if retry_attempt is not None:
        task.record_transport_retry(
            retry_attempt,
            timed_out=transport_event == "timeout",
        )
    cancelled = container.task_manager.cancel_task(task_id)
    return TaskCancelResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        cancellation_requested=cancelled,
    )


@router.get("/sorting/{task_id}/report")
async def get_sorting_report(task_id: str, container: ContainerDep) -> dict[str, Any]:
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    # A report only exists for a completed sort. Returning {} for a still-running
    # or failed task is indistinguishable from a real empty report, so signal the
    # state explicitly: 409 while not completed, 404 if completed without a result.
    if task.status != "completed":
        raise ConflictError(
            f"Report not available: sort task is {task.status!r}, not completed.",
            details={"status": task.status},
        )
    if task.result is None:
        raise TaskNotFoundError(task_id)
    result: dict[str, Any] = task.result
    return result
