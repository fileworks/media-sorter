"""Typed request/response schemas shared by long-operation routes."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.background_tasks.task_manager import Task


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


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

    #: False means ``total`` is not yet known. Render an indeterminate bar —
    #: "0%" would claim no progress when the truth is that nothing is countable
    #: yet.
    total_known: bool = False
    unit: str = "items"
    bytes_done: int = 0
    bytes_total: int = 0
    bytes_total_known: bool = False
    eta_confidence: str = "unknown"
    last_activity_at: str | None = None
    last_checkpoint_at: str | None = None
    last_checkpoint_label: str | None = None
    outcomes: dict[str, int] = Field(default_factory=dict)
    cancellation_requested: bool = False
    cancellation_observed_at: str | None = None
    recovery_phase: str | None = None


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
                total_known=task.progress.total_known,
                unit=task.progress.unit,
                bytes_done=task.progress.bytes_done,
                bytes_total=task.progress.bytes_total,
                bytes_total_known=task.progress.bytes_total_known,
                eta_confidence=task.progress.eta_confidence,
                last_activity_at=_iso(task.progress.last_activity_at),
                last_checkpoint_at=_iso(task.progress.last_checkpoint_at),
                last_checkpoint_label=task.progress.last_checkpoint_label,
                outcomes=dict(task.progress.outcomes),
                cancellation_requested=task.progress.cancellation_requested,
                cancellation_observed_at=_iso(task.progress.cancellation_observed_at),
                recovery_phase=task.progress.recovery_phase,
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
