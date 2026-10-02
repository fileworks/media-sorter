"""Tests for TaskManager — cooperative cancellation semantics (P2-2).

``cancel_task`` must only *request* cancellation (set the task's cancel event)
so a loop-based coroutine can break out gracefully and return its partial
result — the sort relies on this to persist a partial run to the history DB.
A hard ``asyncio.Task.cancel()`` would land at the per-file ``await`` and skip
that persistence entirely. Hard cancellation stays reserved for ``shutdown()``.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any
from unittest.mock import patch

import pytest

from app.background_tasks.task_manager import Task, TaskManager
from app.core.exceptions import ConflictError


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


def test_phase_progress_events_are_local_monotonic_and_bounded() -> None:
    task = Task(id="typed", operation_kind="preview", max_events=3)
    task.transition("scanning_source", total=10)
    task.update_progress(6)
    task.update_progress(4)
    assert task.progress.current == 6
    assert task.progress.percentage == 60

    task.transition("indexing_destination", total=2)
    assert task.progress.current == 0
    assert task.progress.total == 2
    task.add_event("one")
    task.add_event("two")
    task.add_event("three")
    sequences = [event.sequence for event in task.events]
    assert sequences == sorted(sequences)
    assert len(sequences) == 3
    assert task.events_after(sequences[0])[0].sequence == sequences[1]


async def test_same_key_replays_one_task_and_global_gate_reports_active() -> None:
    manager = TaskManager()
    release = asyncio.Event()

    async def blocked(task: Task) -> dict[str, bool]:
        await release.wait()
        return {"ok": True}

    first, replayed = manager.start_task("analysis", "same", blocked)
    again, replayed_again = manager.start_task("analysis", "same", blocked)
    assert replayed is False
    assert replayed_again is True
    assert again.id == first.id

    with pytest.raises(ConflictError) as excinfo:
        manager.start_task("preview", "different", blocked)
    assert excinfo.value.details == {
        "active_task_id": first.id,
        "active_operation_kind": "analysis",
    }
    release.set()
    for _ in range(100):
        if first.status == "completed":
            break
        await asyncio.sleep(0.01)
    assert first.status == "completed"


async def test_terminal_retention_evicts_task_events_and_idempotency() -> None:
    manager = TaskManager(max_terminal_tasks=2, max_events=2)

    async def quick(task: Task) -> dict[str, str]:
        task.add_event("extra")
        return {"id": task.id}

    ids: list[str] = []
    for number in range(3):
        task, _ = manager.start_task("scan", f"key-{number}", quick)
        ids.append(task.id)
        for _ in range(100):
            if task.status == "completed":
                break
            await asyncio.sleep(0.01)
    assert manager.get_task(ids[0]) is None
    assert manager.get_task(ids[1]) is not None
    assert manager.get_task(ids[2]) is not None

    replacement, replayed = manager.start_task("scan", "key-0", quick)
    assert replayed is False
    assert replacement.id != ids[0]


async def test_thread_worker_observes_cooperative_token() -> None:
    manager = TaskManager()
    entered = threading.Event()
    observed = threading.Event()

    async def threaded(task: Task) -> dict[str, bool]:
        def work() -> dict[str, bool]:
            entered.set()
            while not task.cancel_token.is_set():
                time.sleep(0.001)
            observed.set()
            return {"observed": True}

        return await asyncio.to_thread(work)

    task, _ = manager.start_task("scan", "threaded", threaded)
    assert await asyncio.to_thread(entered.wait, 1)
    assert manager.cancel_task(task.id)
    assert await asyncio.to_thread(observed.wait, 1)
    for _ in range(100):
        if task.status == "cancelled":
            break
        await asyncio.sleep(0.01)
    assert task.status == "cancelled"
    assert task.result == {"observed": True}


async def test_lifecycle_logs_use_stable_correlated_event_names() -> None:
    manager = TaskManager()

    async def succeeds(task: Task) -> dict[str, bool]:
        task.transition("scanning_source", total=1)
        task.mark_partial([{"path": "/media/offline", "error_class": "PermissionError"}])
        task.record_transport_retry(1, timed_out=True)
        task.update_progress(1)
        return {"ok": True}

    async def fails(task: Task) -> None:
        task.transition("validating")
        raise RuntimeError("broken")

    async def waits_for_cancel(task: Task) -> dict[str, bool]:
        task.transition("ranking")
        while not task.cancel_token.is_set():
            await asyncio.sleep(0.001)
        return {"cancelled": True}

    with patch("app.background_tasks.task_manager.logger") as lifecycle_logger:
        success, _ = manager.start_task("scan", "log-success", succeeds)
        for _ in range(100):
            if success.status == "completed":
                break
            await asyncio.sleep(0.01)

        failed, _ = manager.start_task("analysis", "log-error", fails)
        for _ in range(100):
            if failed.status == "failed":
                break
            await asyncio.sleep(0.01)

        cancelled, _ = manager.start_task("preview", "log-cancel", waits_for_cancel)
        await asyncio.sleep(0.01)
        assert manager.cancel_task(cancelled.id)
        for _ in range(100):
            if cancelled.status == "cancelled":
                break
            await asyncio.sleep(0.01)

    calls = [
        call.args[0]
        for method in (
            lifecycle_logger.info,
            lifecycle_logger.warning,
            lifecycle_logger.error,
        )
        for call in method.call_args_list
    ]
    assert {
        "operation.started",
        "operation.phase",
        "operation.partial",
        "operation.transport_timeout",
        "operation.transport_retry",
        "operation.succeeded",
        "operation.failed",
        "operation.cancellation_requested",
        "operation.cancellation_observed",
    } <= set(calls)
    for method in (
        lifecycle_logger.info,
        lifecycle_logger.warning,
        lifecycle_logger.error,
    ):
        for call in method.call_args_list:
            if str(call.args[0]).startswith("operation."):
                assert call.kwargs.get("task_id")
                assert call.kwargs.get("operation_kind") in {
                    "analysis",
                    "scan",
                    "preview",
                }
