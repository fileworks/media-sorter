"""Tests for TaskManager — cooperative cancellation semantics (P2-2).

``cancel_task`` must only *request* cancellation (set the task's cancel event)
so a loop-based coroutine can break out gracefully and return its partial
result — the sort relies on this to persist a partial run to the history DB.
A hard ``asyncio.Task.cancel()`` would land at the per-file ``await`` and skip
that persistence entirely. Hard cancellation stays reserved for ``shutdown()``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.background_tasks.task_manager import Task, TaskManager


async def _cooperative_coro(task: Task) -> dict[str, Any]:
    """Mimics SortingService.run: loops, honours cancel_event, returns partial stats."""
    processed = 0
    for _ in range(50):
        if task.cancel_event.is_set():
            break
        await asyncio.sleep(0.01)
        processed += 1
    return {"processed": processed}


async def test_cancel_is_cooperative_and_keeps_partial_result() -> None:
    manager = TaskManager()
    task = manager.create_task(_cooperative_coro)
    await asyncio.sleep(0.05)  # let a few iterations run

    assert manager.cancel_task(task.id) is True

    # The coroutine must be allowed to observe the event and finish on its own
    # (not be hard-cancelled mid-await).
    for _ in range(100):
        if task.status != "running":
            break
        await asyncio.sleep(0.01)

    assert task.status == "cancelled"
    assert task.result is not None
    assert 0 < task.result["processed"] < 50


async def test_cancel_before_terminal_returns_true_after_terminal_false() -> None:
    manager = TaskManager()

    async def quick(task: Task) -> str:
        return "done"

    task = manager.create_task(quick)
    for _ in range(100):
        if task.status == "completed":
            break
        await asyncio.sleep(0.01)
    assert task.status == "completed"
    assert manager.cancel_task(task.id) is False
    assert manager.cancel_task("no-such-id") is False


async def test_uncancelled_task_completes_normally() -> None:
    manager = TaskManager()

    async def quick(task: Task) -> dict[str, int]:
        return {"ok": 1}

    task = manager.create_task(quick)
    for _ in range(100):
        if task.status != "running" and task.status != "pending":
            break
        await asyncio.sleep(0.01)
    assert task.status == "completed"
    assert task.result == {"ok": 1}


async def test_shutdown_hard_cancels_running_tasks() -> None:
    manager = TaskManager()

    async def stubborn(task: Task) -> None:
        await asyncio.sleep(60)  # never checks the cancel event

    task = manager.create_task(stubborn)
    await asyncio.sleep(0.02)
    manager.shutdown()
    for _ in range(100):
        if task.status != "running":
            break
        await asyncio.sleep(0.01)
    assert task.status == "cancelled"
