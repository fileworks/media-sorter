"""Background task manager for long-running sort/preview operations."""

import asyncio
import uuid
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from app.core.logging_config import get_logger

logger = get_logger(__name__)

TaskStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


@dataclass
class TaskProgress:
    current: int = 0
    total: int = 0
    percentage: float = 0.0
    estimated_time_remaining_seconds: float | None = None
    # Coarse stage label so the UI can show meaningful feedback during setup work
    # that happens *before* the per-file loop (directory scan, quality ranking)
    # instead of a frozen 0%. One of: "scanning" | "ranking" | "previewing" |
    # "sorting" | None.
    phase: str | None = None


@dataclass
class Task:
    id: str
    status: TaskStatus = "pending"
    progress: TaskProgress = field(default_factory=TaskProgress)
    result: Any | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    # ``__name__`` of the coroutine this task is running, so callers can ask
    # "is a *sort* already running?" without matching unrelated tasks (preview).
    coroutine_name: str = ""
    _cancel_event: asyncio.Event = field(default_factory=asyncio.Event)

    def cancel(self) -> None:
        self._cancel_event.set()

    @property
    def cancel_event(self) -> asyncio.Event:
        return self._cancel_event


_TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})
# Cap on how many terminal tasks we keep in memory. Old ones are evicted FIFO.
_MAX_TERMINAL_TASKS = 20


class TaskManager:
    """Registry for background async tasks."""

    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._asyncio_tasks: dict[str, asyncio.Task[Any]] = {}

    def _evict_old_terminal_tasks(self) -> None:
        """Drop the oldest terminal tasks if we've hit the retention cap."""
        terminal = [t for t in self._tasks.values() if t.status in _TERMINAL_STATUSES]
        if len(terminal) <= _MAX_TERMINAL_TASKS:
            return
        # Sort by finish time; evict the earliest (oldest) ones first.
        terminal.sort(key=lambda t: t.finished_at or t.created_at)
        for t in terminal[: len(terminal) - _MAX_TERMINAL_TASKS]:
            self._tasks.pop(t.id, None)
            self._asyncio_tasks.pop(t.id, None)

    def has_non_terminal_task(self, coroutine_name: str) -> bool:
        """Return True if there is a running/pending task for *coroutine_name*.

        Used by the sort route to reject a second concurrent sort (409).
        ``coroutine_name`` is matched against the async function's ``__name__``.
        """
        return any(
            t.status not in _TERMINAL_STATUSES and t.coroutine_name == coroutine_name
            for t in self._tasks.values()
        )

    def create_task(
        self,
        coro: Callable[..., Coroutine[Any, Any, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> Task:
        task_id = str(uuid.uuid4())
        task = Task(id=task_id, coroutine_name=getattr(coro, "__name__", ""))
        self._tasks[task_id] = task

        async def _run() -> None:
            task.status = "running"
            try:
                task.result = await coro(task, *args, **kwargs)
                # A coroutine that honoured a cooperative cancel (cancel_task
                # sets the event; the sort/preview loops break on it) returns
                # normally with its partial result — report it as cancelled,
                # not completed, while keeping the result available.
                task.status = "cancelled" if task.cancel_event.is_set() else "completed"
            except asyncio.CancelledError:
                task.status = "cancelled"
            except Exception as exc:
                task.status = "failed"
                task.error = str(exc)
                logger.error("Task failed", task_id=task_id, error=str(exc), exc_info=True)
            finally:
                task.finished_at = datetime.now(timezone.utc)
                self._evict_old_terminal_tasks()

        asyncio_task = asyncio.create_task(_run())
        self._asyncio_tasks[task_id] = asyncio_task
        logger.info("Task created", task_id=task_id)
        return task

    def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def cancel_task(self, task_id: str) -> bool:
        """Request cooperative cancellation of a running task.

        Only sets the task's cancel event — the sort/preview loops check it
        between files, break out, and (for a sort) persist the partial run.
        Hard-cancelling the asyncio task here would land a ``CancelledError``
        at the per-file ``await``, skipping that persistence entirely and
        marking the task terminal while its worker thread may still be
        mid-copy (letting a second sort start concurrently). The task turns
        ``cancelled`` once its loop observes the event; hard cancellation is
        reserved for :meth:`shutdown` (process exit).
        """
        task = self._tasks.get(task_id)
        if not task:
            return False
        if task.status in ("completed", "failed", "cancelled"):
            return False
        task.cancel()
        logger.info("Task cancellation requested", task_id=task_id)
        return True

    def shutdown(self) -> None:
        for asyncio_task in self._asyncio_tasks.values():
            asyncio_task.cancel()
        logger.info("TaskManager shutdown, cancelled all tasks")
