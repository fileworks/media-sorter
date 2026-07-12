"""Scan routes — list files, dry-run preview, and directory analysis."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import ConfigDep, ContainerDep
from app.api.schemas import TaskProgressResponse
from app.core.exceptions import ConfigError, TaskNotFoundError

router = APIRouter()


class ScanResponse(BaseModel):
    files: list[str]
    total: int


class DiskSpaceResponse(BaseModel):
    source_size_bytes: int
    destination_free_bytes: int
    sufficient: bool
    mode: str
    free_space_known: bool


class DateRangeResponse(BaseModel):
    earliest: str | None
    latest: str | None
    no_date_estimate: int


class AnalysisResponse(BaseModel):
    total_files: int
    total_size_bytes: int
    by_type: dict[str, int]
    date_range: DateRangeResponse
    disk_space: DiskSpaceResponse
    excluded_files: int
    estimated_duration_seconds: int
    warnings: list[str]


@router.post("/scan", response_model=ScanResponse)
async def scan(container: ContainerDep, config: ConfigDep) -> ScanResponse:
    if not config.source_directory:
        raise ConfigError("source_directory is required for scan")
    files = await container.filesystem_service.list_files(
        config.source_directory,
        exclude_patterns=config.exclude_patterns,
        min_file_size_kb=config.min_file_size_kb,
        max_file_size_mb=config.max_file_size_mb,
    )
    return ScanResponse(files=[str(f) for f in files], total=len(files))


@router.post("/preview")
async def preview(container: ContainerDep, config: ConfigDep) -> dict[str, Any]:
    """Dry-run preview (synchronous, no progress) — kept for simple callers/tests.

    Returns the rich preview payload as a ``dict``: its shape tracks the sort
    pipeline (per-file predicted destinations, duplicate/convert/rename
    outcomes) and a strict response model would risk silently dropping fields.
    """
    return await container.preview_service.preview(config)


@router.post("/preview/start")
async def start_preview(container: ContainerDep, config: ConfigDep) -> dict[str, str]:
    """Start a preview as a background task so the client can poll real progress."""
    task = container.task_manager.create_task(
        container.preview_service.run_preview,
        config=config,
    )
    return {"task_id": task.id}


@router.post("/preview/{task_id}/cancel")
async def cancel_preview(task_id: str, container: ContainerDep) -> dict[str, str]:
    """Cancel a running preview task."""
    task = container.task_manager.get_task(task_id)
    if not task:
        raise TaskNotFoundError(task_id)
    cancelled = container.task_manager.cancel_task(task_id)
    if not cancelled:
        # Task exists but is already in a terminal state.
        return {"status": task.status}
    return {"status": "cancelled"}


@router.get("/preview/{task_id}", response_model=TaskProgressResponse)
async def get_preview_progress(task_id: str, container: ContainerDep) -> TaskProgressResponse:
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


@router.post("/analysis", response_model=AnalysisResponse)
async def analysis(container: ContainerDep, config: ConfigDep) -> AnalysisResponse:
    """Fast directory analysis: file counts, type breakdown, disk space, duration estimate."""
    if not config.source_directory:
        raise ConfigError("source_directory is required for analysis")
    result = await container.analysis_service.analyse(config)
    return AnalysisResponse(**result)


@router.get("/analysis/disk-space", response_model=DiskSpaceResponse)
async def disk_space(container: ContainerDep, config: ConfigDep) -> DiskSpaceResponse:
    """Real-time disk space check for config panel."""
    result = await container.analysis_service.disk_space_check(config)
    return DiskSpaceResponse(**result)
