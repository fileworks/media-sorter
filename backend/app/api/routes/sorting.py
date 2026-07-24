"""Sorting routes — start, status, cancel, and report."""

from typing import Any

from fastapi import APIRouter, Header, Query

from app.api.deps import ContainerDep
from app.api.schemas import (
    TaskCancelResponse,
    TaskProgressResponse,
    TaskStartRequest,
    TaskStartResponse,
)
from app.core.exceptions import ConflictError, TaskNotFoundError

router = APIRouter()


class StartSortRequest(TaskStartRequest):
    dry_run: bool = False


@router.post("/sorting/start", response_model=TaskStartResponse)
async def start_sorting(
    container: ContainerDep,
    body: StartSortRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or StartSortRequest()
    task, replayed = container.task_manager.start_task(
        "sort",
        request.idempotency_key,
        container.sorting_service.run,
        dry_run=request.dry_run,
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
