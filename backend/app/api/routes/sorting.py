"""Sorting routes — start, status, cancel, and report."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import ContainerDep
from app.api.schemas import TaskProgressResponse
from app.core.exceptions import ConflictError, TaskNotFoundError

router = APIRouter()


class StartSortRequest(BaseModel):
    dry_run: bool = False


@router.post("/sorting/start")
async def start_sorting(body: StartSortRequest, container: ContainerDep) -> dict[str, str]:
    if container.task_manager.has_non_terminal_task("run"):
        raise ConflictError("A sort is already in progress. Cancel it before starting a new one.")
    task = container.task_manager.create_task(
        container.sorting_service.run,
        dry_run=body.dry_run,
    )
    return {"task_id": task.id}


@router.get("/sorting/{task_id}", response_model=TaskProgressResponse)
async def get_sorting_progress(task_id: str, container: ContainerDep) -> TaskProgressResponse:
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    return TaskProgressResponse(
        task_id=task.id,
        status=task.status,
        progress={
            "current": task.progress.current,
            "total": task.progress.total,
            "percentage": task.progress.percentage,
            "estimated_time_remaining_seconds": task.progress.estimated_time_remaining_seconds,
            "phase": task.progress.phase,
        },
        error=task.error,
        result=task.result,
    )


@router.post("/sorting/{task_id}/cancel")
async def cancel_sorting(task_id: str, container: ContainerDep) -> dict[str, str]:
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    cancelled = container.task_manager.cancel_task(task_id)
    if not cancelled:
        return {"status": task.status}
    return {"status": "cancelled"}


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
