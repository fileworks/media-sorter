"""Sorting routes — start, status, cancel, and report."""

from typing import Any

from fastapi import APIRouter, Header, Query
from pydantic import Field

from app.api.deps import ContainerDep
from app.api.schemas import (
    TaskCancelResponse,
    TaskProgressResponse,
    TaskStartRequest,
    TaskStartResponse,
)
from app.core.config_fingerprint import config_fingerprint
from app.core.exceptions import ConflictError, TaskNotFoundError
from app.core.sort_plan import FrozenSortImpact

router = APIRouter()


class StartSortRequest(TaskStartRequest):
    dry_run: bool = False
    expected_config_fingerprint: str | None = None
    plan_id: str | None = None
    #: Sources Review decided not to act on. Applied to a derived copy of the
    #: stored plan; the stored plan is never mutated, so a second run of the
    #: same plan is unaffected by one run's exclusions.
    excluded_sources: list[str] = Field(default_factory=list)
    #: Content hash → the path Review chose to keep. Applied to the derived
    #: plan, so one run's overrides do not follow the stored plan around.
    reviewed_keepers: dict[str, str] = Field(default_factory=dict)


class PlanImpactRequest(TaskStartRequest):
    """The exclusions a run would carry, so its impact can be described."""

    plan_id: str
    excluded_sources: list[str] = Field(default_factory=list)


@router.post("/sorting/impact", response_model=FrozenSortImpact)
async def plan_impact(container: ContainerDep, body: PlanImpactRequest) -> FrozenSortImpact:
    """What a run with these exclusions would actually do.

    The Execute preflight used to derive this itself, by subtracting a
    per-reviewed-file tally from the stored plan's action-level totals. The two
    counted different things — a companion is an action but not a reviewed file
    — so excluding a RAW+JPEG pair left the preflight promising a copy that
    would never happen. The plan is the only thing that knows, so it answers.
    """
    plan = container.preview_service.frozen_plan(body.plan_id)
    if plan is None:
        raise ConflictError(
            "The reviewed plan is no longer available; generate preview again.",
            details={"reason": "missing_plan", "plan_id": body.plan_id},
        )
    return plan.with_exclusions(body.excluded_sources).impact


@router.post("/sorting/start", response_model=TaskStartResponse)
async def start_sorting(
    container: ContainerDep,
    body: StartSortRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or StartSortRequest()
    current_fingerprint = config_fingerprint(container.config)
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
        if request.reviewed_keepers:
            frozen_plan = frozen_plan.with_reviewed_keepers(request.reviewed_keepers)
        if request.excluded_sources:
            # A derived plan, never an edit of the stored one. Excluding a
            # companion excludes its whole unit, which is expanded server-side
            # so a client cannot half-exclude a RAW+JPEG pair.
            frozen_plan = frozen_plan.with_exclusions(request.excluded_sources)
    task, replayed = container.task_manager.start_task(
        "sort",
        request.idempotency_key,
        container.sorting_service.run,
        dry_run=request.dry_run,
        frozen_plan=frozen_plan,
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
