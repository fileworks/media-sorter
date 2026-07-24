"""Source scan, analysis, and preview task routes."""

from __future__ import annotations

import asyncio
from typing import Any, cast

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.api.schemas import (
    TaskCancelResponse,
    TaskProgressResponse,
    TaskStartRequest,
    TaskStartResponse,
)
from app.background_tasks.task_manager import Task
from app.core.config import Config
from app.core.exceptions import TaskNotFoundError
from app.utils.path_utils import validate_source_root, validate_source_target_overlap

router = APIRouter()


class ScanResponse(BaseModel):
    files: list[str]
    total: int
    excluded_files: int = 0
    partial: bool = False
    issues: list[dict[str, Any]] = Field(default_factory=list)


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
    partial: bool = False
    issues: list[dict[str, Any]] = Field(default_factory=list)


def _snapshot(config: Config) -> Config:
    return Config.from_dict(config.to_dict())


async def _scan_operation(task: Task, container: Any, config: Config) -> dict[str, Any]:
    task.transition("validating")
    source = await asyncio.to_thread(validate_source_root, config.source_directory)
    if config.target_directory:
        await asyncio.to_thread(
            validate_source_target_overlap,
            source,
            config.target_directory,
        )
    task.transition("scanning_source")
    traversal = await container.filesystem_service.traverse(
        source,
        recursive=config.recursive_scan,
        max_depth=config.max_recursion_depth,
        exclude_patterns=config.exclude_patterns,
        min_file_size_kb=config.min_file_size_kb,
        max_file_size_mb=config.max_file_size_mb,
        cancel_token=task.cancel_token,
        task=task,
    )
    task.update_progress(len(traversal.files), total=len(traversal.files))
    return ScanResponse(
        files=[str(path) for path in traversal.files],
        total=len(traversal.files),
        excluded_files=traversal.excluded_files,
        partial=traversal.partial,
        issues=[issue.to_dict() for issue in traversal.issues],
    ).model_dump()


async def _analysis_operation(task: Task, container: Any, config: Config) -> dict[str, Any]:
    return cast(dict[str, Any], await container.analysis_service.analyse(config, task=task))


@router.post("/scan", response_model=ScanResponse)
async def scan(container: ContainerDep, config: ConfigDep) -> ScanResponse:
    """Compatibility endpoint; shipped clients use the task transport."""
    source = await asyncio.to_thread(validate_source_root, config.source_directory)
    if config.target_directory:
        await asyncio.to_thread(
            validate_source_target_overlap,
            source,
            config.target_directory,
        )
    traversal = await container.filesystem_service.traverse(
        source,
        recursive=config.recursive_scan,
        max_depth=config.max_recursion_depth,
        exclude_patterns=config.exclude_patterns,
        min_file_size_kb=config.min_file_size_kb,
        max_file_size_mb=config.max_file_size_mb,
    )
    return ScanResponse(
        files=[str(path) for path in traversal.files],
        total=len(traversal.files),
        excluded_files=traversal.excluded_files,
        partial=traversal.partial,
        issues=[issue.to_dict() for issue in traversal.issues],
    )


@router.post("/scan/start", response_model=TaskStartResponse)
async def start_scan(
    container: ContainerDep,
    config: ConfigDep,
    body: TaskStartRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or TaskStartRequest()
    task, replayed = container.task_manager.start_task(
        "scan",
        request.idempotency_key,
        _scan_operation,
        container,
        _snapshot(config),
    )
    _record_transport(task, retry_attempt, transport_event)
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/scan/{task_id}", response_model=TaskProgressResponse)
async def get_scan_progress(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskProgressResponse:
    return _task_status(task_id, container, after_sequence, retry_attempt, transport_event)


@router.post("/scan/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_scan(
    task_id: str,
    container: ContainerDep,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskCancelResponse:
    return _cancel_task(task_id, container, retry_attempt, transport_event)


@router.post("/preview")
async def preview(container: ContainerDep, config: ConfigDep) -> dict[str, Any]:
    """Compatibility endpoint; shipped clients use the task transport."""
    return await container.preview_service.preview(config)


@router.post("/preview/start", response_model=TaskStartResponse)
async def start_preview(
    container: ContainerDep,
    config: ConfigDep,
    body: TaskStartRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or TaskStartRequest()
    task, replayed = container.task_manager.start_task(
        "preview",
        request.idempotency_key,
        container.preview_service.run_preview,
        config=_snapshot(config),
    )
    _record_transport(task, retry_attempt, transport_event)
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/preview/{task_id}", response_model=TaskProgressResponse)
async def get_preview_progress(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskProgressResponse:
    return _task_status(task_id, container, after_sequence, retry_attempt, transport_event)


@router.post("/preview/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_preview(
    task_id: str,
    container: ContainerDep,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskCancelResponse:
    return _cancel_task(task_id, container, retry_attempt, transport_event)


@router.post("/analysis", response_model=AnalysisResponse)
async def analysis(container: ContainerDep, config: ConfigDep) -> AnalysisResponse:
    """Compatibility endpoint; shipped clients use the task transport."""
    return AnalysisResponse(**(await container.analysis_service.analyse(config)))


@router.get("/analysis/disk-space", response_model=DiskSpaceResponse)
async def disk_space(container: ContainerDep, config: ConfigDep) -> DiskSpaceResponse:
    result = await container.analysis_service.disk_space_check(config)
    return DiskSpaceResponse(**result)


@router.post("/analysis/start", response_model=TaskStartResponse)
async def start_analysis(
    container: ContainerDep,
    config: ConfigDep,
    body: TaskStartRequest | None = None,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskStartResponse:
    request = body or TaskStartRequest()
    task, replayed = container.task_manager.start_task(
        "analysis",
        request.idempotency_key,
        _analysis_operation,
        container,
        _snapshot(config),
    )
    _record_transport(task, retry_attempt, transport_event)
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/analysis/{task_id}", response_model=TaskProgressResponse)
async def get_analysis_progress(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskProgressResponse:
    return _task_status(task_id, container, after_sequence, retry_attempt, transport_event)


@router.post("/analysis/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_analysis(
    task_id: str,
    container: ContainerDep,
    retry_attempt: int | None = Header(default=None, alias="X-MediaSorter-Retry-Attempt"),
    transport_event: str | None = Header(default=None, alias="X-MediaSorter-Transport-Event"),
) -> TaskCancelResponse:
    return _cancel_task(task_id, container, retry_attempt, transport_event)


def _task_status(
    task_id: str,
    container: Any,
    after_sequence: int,
    retry_attempt: int | None,
    transport_event: str | None,
) -> TaskProgressResponse:
    task = container.task_manager.get_task(task_id)
    if task is None:
        raise TaskNotFoundError(task_id)
    _record_transport(task, retry_attempt, transport_event)
    return TaskProgressResponse.from_task(task, after_sequence=after_sequence)


def _cancel_task(
    task_id: str,
    container: Any,
    retry_attempt: int | None,
    transport_event: str | None,
) -> TaskCancelResponse:
    task = container.task_manager.get_task(task_id)
    if task is None:
        raise TaskNotFoundError(task_id)
    _record_transport(task, retry_attempt, transport_event)
    requested = container.task_manager.cancel_task(task_id)
    return TaskCancelResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        cancellation_requested=requested,
    )


def _record_transport(
    task: Task,
    retry_attempt: int | None,
    transport_event: str | None,
) -> None:
    if retry_attempt is not None:
        task.record_transport_retry(
            retry_attempt,
            timed_out=transport_event == "timeout",
        )
