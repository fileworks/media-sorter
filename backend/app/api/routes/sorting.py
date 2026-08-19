"""Sorting routes — start, status, cancel, and report."""

import asyncio
from pathlib import Path
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
from app.core.paths import resolve_app_paths
from app.core.run_scope import apply_run_scope
from app.core.sort_plan import FrozenSortImpact, ReviewedSet
from app.services.catalog_location import live_catalog_generation
from app.services.quarantine import PreflightResult, preflight, store_for_state_root

router = APIRouter()


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
