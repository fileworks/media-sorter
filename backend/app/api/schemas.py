"""Typed request/response schemas shared by long-operation routes."""

from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel, Field

from app.background_tasks.task_manager import Task


class TaskStartRequest(BaseModel):
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1)


class TaskStartResponse(BaseModel):
    task_id: str
    operation_kind: str
    status: str
    replayed: bool = False


class TaskProgressData(BaseModel):
    current: int
    total: int
    percentage: float
    estimated_time_remaining_seconds: float | None = None
    phase: str | None = None


class TaskEventResponse(BaseModel):
    sequence: int
    name: str
    timestamp: str
    phase: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class TaskFailureResponse(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class TaskProgressResponse(BaseModel):
    task_id: str
    operation_kind: str
    status: str
    progress: TaskProgressData
    partial: bool = False
    issues: list[dict[str, Any]] = Field(default_factory=list)
    events: list[TaskEventResponse] = Field(default_factory=list)
    last_event_sequence: int = 0
    error: str | None = None
    failure: TaskFailureResponse | None = None
    result: dict[str, Any] | None = None

    @classmethod
    def from_task(cls, task: Task, *, after_sequence: int = 0) -> TaskProgressResponse:
        event_snapshot, last_event_sequence = task.event_snapshot_after(after_sequence)
        events = [event.to_dict() for event in event_snapshot]
        return cls(
            task_id=task.id,
            operation_kind=task.operation_kind,
            status=task.status,
            progress=TaskProgressData(
                current=task.progress.current,
                total=task.progress.total,
                percentage=task.progress.percentage,
                estimated_time_remaining_seconds=task.progress.estimated_time_remaining_seconds,
                phase=task.progress.phase,
            ),
            partial=task.partial,
            issues=task.issues,
            events=[TaskEventResponse(**event) for event in events],
            last_event_sequence=last_event_sequence,
            error=task.error,
            failure=(
                TaskFailureResponse(**task.failure.to_dict()) if task.failure is not None else None
            ),
            result=task.result,
        )


class TaskCancelResponse(BaseModel):
    task_id: str
    operation_kind: str
    status: str
    cancellation_requested: bool
