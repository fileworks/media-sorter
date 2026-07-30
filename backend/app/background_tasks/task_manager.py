"""In-memory lifecycle manager for long-running media operations."""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from app.core.exceptions import ConflictError, MediaSortException
from app.core.logging_config import get_logger

logger = get_logger(__name__)


def _eta_confidence(
    eta_seconds: float | None,
    *,
    total_known: bool,
    observed: int,
) -> EtaConfidence:
    """Rate an ETA honestly rather than presenting every guess identically.

    Without a real total there is nothing to estimate against, and a handful of
    samples on variable-sized media says very little about what remains.
    """
    if eta_seconds is None or not total_known:
        return "unknown"
    if observed < 10:
        return "low"
    if observed < 50:
        return "medium"
    return "high"


TaskStatus = Literal["pending", "running", "completed", "failed", "cancelled"]
OperationKind = Literal[
    "analysis",
    "scan",
    "preview",
    "sort",
    "audit",
    "reconcile",
    "model_download",
]
ProgressUnit = Literal["items", "bytes"]
EtaConfidence = Literal["unknown", "low", "medium", "high"]
TaskPhase = Literal[
    "validating",
    "scanning_source",
    "indexing_destination",
    "ranking",
    "analyzing",
    "previewing",
    "sorting",
    "auditing",
    "reconciling",
    "downloading_model",
    "verifying_model",
    "publishing_model",
]

_TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})
_DEFAULT_MAX_TERMINAL_TASKS = 20
_DEFAULT_MAX_EVENTS = 100


class CancellationToken:
    """Thread-safe cooperative cancellation shared by async and worker code."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def set(self) -> None:
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)


@dataclass
class TaskProgress:
    current: int = 0
    total: int = 0
    percentage: float = 0.0
    estimated_time_remaining_seconds: float | None = None
    phase: TaskPhase | None = None

    #: Whether ``total`` is a real count or a placeholder. A client must render
    #: an indeterminate bar when this is false rather than showing "0%", which
    #: reads as "no progress" when the truth is "we do not know yet".
    total_known: bool = False
    unit: ProgressUnit = "items"
    bytes_done: int = 0
    bytes_total: int = 0
    bytes_total_known: bool = False
    #: How much the ETA is worth. Never "high" while the total is unknown.
    eta_confidence: EtaConfidence = "unknown"
    #: Liveness. A client can tell "slow but working" from "stuck" by comparing
    #: this to the wall clock, without the backend guessing a timeout.
    last_activity_at: datetime | None = None
    #: The last point from which an interruption is recoverable without loss.
    last_checkpoint_at: datetime | None = None
    last_checkpoint_label: str | None = None
    outcomes: dict[str, int] = field(default_factory=dict)
    cancellation_requested: bool = False
    cancellation_observed_at: datetime | None = None
    recovery_phase: str | None = None


@dataclass(frozen=True)
class TaskEvent:
    sequence: int
    name: str
    timestamp: datetime
    phase: TaskPhase | None
    fields: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "name": self.name,
            "timestamp": self.timestamp.isoformat(),
            "phase": self.phase,
            "fields": self.fields,
        }


@dataclass(frozen=True)
class TaskFailure:
    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


@dataclass
class Task:
    id: str
    operation_kind: OperationKind = "sort"
    idempotency_key: str = ""
    status: TaskStatus = "pending"
    progress: TaskProgress = field(default_factory=TaskProgress)
    partial: bool = False
    issues: list[dict[str, Any]] = field(default_factory=list)
    result: Any | None = None
    error: str | None = None
    failure: TaskFailure | None = None
    events: list[TaskEvent] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = None
    finished_at: datetime | None = None
    coroutine_name: str = ""
    max_events: int = _DEFAULT_MAX_EVENTS
    _cancel_event: CancellationToken = field(default_factory=CancellationToken)
    _event_sequence: int = 0
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    def cancel(self) -> None:
        self._cancel_event.set()

    @property
    def cancel_event(self) -> CancellationToken:
        """Compatibility name used throughout the media services."""
        return self._cancel_event

    @property
    def cancel_token(self) -> CancellationToken:
        return self._cancel_event

    def add_event(self, name: str, **fields: Any) -> TaskEvent:
        with self._lock:
            self._event_sequence += 1
            event = TaskEvent(
                sequence=self._event_sequence,
                name=name,
                timestamp=datetime.now(timezone.utc),
                phase=self.progress.phase,
                fields=fields,
            )
            self.events.append(event)
            if len(self.events) > self.max_events:
                del self.events[: len(self.events) - self.max_events]
            return event

    def transition(self, phase: TaskPhase, *, total: int = 0) -> None:
        with self._lock:
            if self.progress.phase == phase:
                return
            carried = self.progress
            self.progress = TaskProgress(
                phase=phase,
                total=max(0, total),
                total_known=total > 0,
                unit=carried.unit,
                outcomes=dict(carried.outcomes),
                cancellation_requested=carried.cancellation_requested,
                cancellation_observed_at=carried.cancellation_observed_at,
                recovery_phase=carried.recovery_phase,
                last_activity_at=datetime.now(timezone.utc),
                last_checkpoint_at=carried.last_checkpoint_at,
                last_checkpoint_label=carried.last_checkpoint_label,
            )
            self.add_event("operation.phase", total=max(0, total), total_known=total > 0)
        logger.info(
            "operation.phase",
            task_id=self.id,
            operation_kind=self.operation_kind,
            phase=phase,
            total=max(0, total),
        )

    def update_progress(
        self,
        current: int,
        *,
        total: int | None = None,
        eta_seconds: float | None = None,
        bytes_done: int | None = None,
        bytes_total: int | None = None,
        unit: ProgressUnit | None = None,
    ) -> None:
        with self._lock:
            if total is not None:
                self.progress.total = max(0, total)
                self.progress.total_known = total > 0
            if bytes_done is not None:
                self.progress.bytes_done = max(0, bytes_done)
            if bytes_total is not None:
                self.progress.bytes_total = max(0, bytes_total)
                self.progress.bytes_total_known = bytes_total > 0
            if unit is not None:
                self.progress.unit = unit
            self.progress.last_activity_at = datetime.now(timezone.utc)
            bounded = max(self.progress.current, current)
            if self.progress.total:
                bounded = min(bounded, self.progress.total)
            self.progress.current = max(0, bounded)
            self.progress.percentage = (
                round(self.progress.current / self.progress.total * 100, 1)
                if self.progress.total
                else 0.0
            )
            self.progress.estimated_time_remaining_seconds = eta_seconds
            self.progress.eta_confidence = _eta_confidence(
                eta_seconds,
                total_known=self.progress.total_known,
                observed=self.progress.current,
            )
            self.add_event(
                "operation.progress",
                current=self.progress.current,
                total=self.progress.total,
                total_known=self.progress.total_known,
                percentage=self.progress.percentage,
                eta_confidence=self.progress.eta_confidence,
            )

    def checkpoint(self, label: str) -> None:
        """Record the last point an interruption could resume from safely."""
        with self._lock:
            self.progress.last_checkpoint_at = datetime.now(timezone.utc)
            self.progress.last_checkpoint_label = label
            self.add_event("operation.checkpoint", checkpoint=label)

    def record_outcome(self, code: str, *, count: int = 1) -> None:
        """Tally one terminal per-item outcome so success never hides failures."""
        with self._lock:
            self.progress.outcomes[code] = self.progress.outcomes.get(code, 0) + count
            self.progress.last_activity_at = datetime.now(timezone.utc)

    def observe_cancellation(self) -> None:
        """Record that the worker actually noticed the cancellation request."""
        with self._lock:
            if self.progress.cancellation_observed_at is not None:
                return
            self.progress.cancellation_observed_at = datetime.now(timezone.utc)
            self.add_event("operation.cancellation_observed")

    def enter_recovery(self, phase: str) -> None:
        """Report that this operation is reconciling rather than doing new work."""
        with self._lock:
            self.progress.recovery_phase = phase
            self.add_event("operation.recovery", recovery_phase=phase)

    def mark_partial(self, issues: list[dict[str, Any]]) -> None:
        if not issues:
            return
        with self._lock:
            self.partial = True
            self.issues.extend(issues)
            self.add_event("operation.partial", issue_count=len(issues))
        logger.warning(
            "operation.partial",
            task_id=self.id,
            operation_kind=self.operation_kind,
            phase=self.progress.phase,
            issue_count=len(issues),
        )

    def events_after(self, sequence: int) -> list[TaskEvent]:
        with self._lock:
            return [event for event in self.events if event.sequence > sequence]

    def event_snapshot_after(self, sequence: int) -> tuple[list[TaskEvent], int]:
        """Atomically snapshot reconnectable events and their latest sequence."""
        with self._lock:
            events = [event for event in self.events if event.sequence > sequence]
            latest = self.events[-1].sequence if self.events else 0
            return events, latest

    def record_transport_retry(self, attempt: int, *, timed_out: bool = False) -> None:
        """Correlate a client-side timeout/retry observed on a later request."""
        if timed_out:
            self.add_event("operation.transport_timeout", attempt=attempt)
            logger.warning(
                "operation.transport_timeout",
                task_id=self.id,
                operation_kind=self.operation_kind,
                phase=self.progress.phase,
                attempt=attempt,
            )
        self.add_event("operation.transport_retry", attempt=attempt)
        logger.info(
            "operation.transport_retry",
            task_id=self.id,
            operation_kind=self.operation_kind,
            phase=self.progress.phase,
            attempt=attempt,
        )


class TaskManager:
    """Registry with one scan-family flight and retained idempotent starts."""

    def __init__(
        self,
        *,
        max_terminal_tasks: int = _DEFAULT_MAX_TERMINAL_TASKS,
        max_events: int = _DEFAULT_MAX_EVENTS,
    ) -> None:
        self._tasks: dict[str, Task] = {}
        self._asyncio_tasks: dict[str, asyncio.Task[Any]] = {}
        self._idempotency: dict[tuple[OperationKind, str], str] = {}
        self._max_terminal_tasks = max(1, max_terminal_tasks)
        self._max_events = max(1, max_events)

    def _evict_old_terminal_tasks(self) -> None:
        terminal = [task for task in self._tasks.values() if task.status in _TERMINAL_STATUSES]
        if len(terminal) <= self._max_terminal_tasks:
            return
        terminal.sort(key=lambda task: task.finished_at or task.created_at)
        for task in terminal[: len(terminal) - self._max_terminal_tasks]:
            self._tasks.pop(task.id, None)
            self._asyncio_tasks.pop(task.id, None)
            key = (task.operation_kind, task.idempotency_key)
            if task.idempotency_key and self._idempotency.get(key) == task.id:
                self._idempotency.pop(key, None)

    def active_task(self) -> Task | None:
        return next(
            (task for task in self._tasks.values() if task.status not in _TERMINAL_STATUSES),
            None,
        )

    def has_non_terminal_task(self, coroutine_name: str | None = None) -> bool:
        return any(
            task.status not in _TERMINAL_STATUSES
            and (coroutine_name is None or task.coroutine_name == coroutine_name)
            for task in self._tasks.values()
        )

    def start_task(
        self,
        operation_kind: OperationKind,
        idempotency_key: str,
        coro: Callable[..., Coroutine[Any, Any, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> tuple[Task, bool]:
        key = idempotency_key.strip()
        if not key:
            raise ValueError("idempotency_key must not be empty")

        mapped_id = self._idempotency.get((operation_kind, key))
        if mapped_id is not None:
            mapped = self._tasks.get(mapped_id)
            if mapped is not None:
                mapped.add_event("operation.start_replayed")
                return mapped, True
            self._idempotency.pop((operation_kind, key), None)

        active = self.active_task()
        if active is not None:
            raise ConflictError(
                f"A {active.operation_kind} operation is already active.",
                details={
                    "active_task_id": active.id,
                    "active_operation_kind": active.operation_kind,
                },
            )

        task = self._create(
            operation_kind,
            key,
            coro,
            *args,
            **kwargs,
        )
        self._idempotency[(operation_kind, key)] = task.id
        return task, False

    def create_task(
        self,
        coro: Callable[..., Coroutine[Any, Any, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> Task:
        """Compatibility entry point; new routes should call :meth:`start_task`."""
        name = getattr(coro, "__name__", "")
        kind: OperationKind
        if "preview" in name:
            kind = "preview"
        elif "analys" in name:
            kind = "analysis"
        elif "scan" in name:
            kind = "scan"
        else:
            kind = "sort"
        return self._create(kind, str(uuid.uuid4()), coro, *args, **kwargs)

    def _create(
        self,
        operation_kind: OperationKind,
        idempotency_key: str,
        coro: Callable[..., Coroutine[Any, Any, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> Task:
        task_id = str(uuid.uuid4())
        task = Task(
            id=task_id,
            operation_kind=operation_kind,
            idempotency_key=idempotency_key,
            coroutine_name=getattr(coro, "__name__", ""),
            max_events=self._max_events,
        )
        self._tasks[task_id] = task

        async def _run() -> None:
            task.status = "running"
            task.started_at = datetime.now(timezone.utc)
            started = time.monotonic()
            task.add_event("operation.started")
            logger.info(
                "operation.started",
                task_id=task.id,
                operation_kind=task.operation_kind,
            )
            try:
                task.result = await coro(task, *args, **kwargs)
                task.status = "cancelled" if task.cancel_token.is_set() else "completed"
                event_name = (
                    "operation.cancellation_observed"
                    if task.status == "cancelled"
                    else "operation.succeeded"
                )
                task.add_event(event_name, elapsed_seconds=round(time.monotonic() - started, 3))
                logger.info(
                    event_name,
                    task_id=task.id,
                    operation_kind=task.operation_kind,
                    phase=task.progress.phase,
                    elapsed_seconds=round(time.monotonic() - started, 3),
                    partial=task.partial,
                )
            except asyncio.CancelledError:
                task.status = "cancelled"
                task.add_event("operation.cancellation_observed")
                raise
            except Exception as exc:
                if task.cancel_token.is_set():
                    task.status = "cancelled"
                    task.add_event(
                        "operation.cancellation_observed",
                        elapsed_seconds=round(time.monotonic() - started, 3),
                    )
                    logger.info(
                        "operation.cancellation_observed",
                        task_id=task.id,
                        operation_kind=task.operation_kind,
                        phase=task.progress.phase,
                    )
                    return
                task.status = "failed"
                if isinstance(exc, MediaSortException):
                    task.failure = TaskFailure(exc.code, exc.message, exc.details)
                    task.error = exc.message
                else:
                    task.failure = TaskFailure("INTERNAL_ERROR", str(exc))
                    task.error = str(exc)
                task.add_event(
                    "operation.failed",
                    code=task.failure.code,
                    elapsed_seconds=round(time.monotonic() - started, 3),
                )
                logger.error(
                    "operation.failed",
                    task_id=task.id,
                    operation_kind=task.operation_kind,
                    phase=task.progress.phase,
                    error_code=task.failure.code,
                    error=task.failure.message,
                    elapsed_seconds=round(time.monotonic() - started, 3),
                    exc_info=True,
                )
            finally:
                task.finished_at = datetime.now(timezone.utc)
                self._evict_old_terminal_tasks()

        self._asyncio_tasks[task_id] = asyncio.create_task(_run())
        return task

    def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def tasks(self) -> tuple[Task, ...]:
        """Return a stable snapshot for status surfaces."""
        return tuple(self._tasks.values())

    def cancel_task(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is None or task.status in _TERMINAL_STATUSES:
            return False
        if not task.cancel_token.is_set():
            task.cancel()
            task.add_event("operation.cancellation_requested")
            logger.info(
                "operation.cancellation_requested",
                task_id=task.id,
                operation_kind=task.operation_kind,
                phase=task.progress.phase,
            )
        return True

    def shutdown(self) -> None:
        for asyncio_task in self._asyncio_tasks.values():
            asyncio_task.cancel()
        logger.info("TaskManager shutdown, cancelled all tasks")
