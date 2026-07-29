"""Progress must be honest: unknown totals, real liveness, visible outcomes."""

from __future__ import annotations

from app.api.schemas import TaskProgressResponse
from app.background_tasks.task_manager import Task


def _task() -> Task:
    return Task(id="task_1", operation_kind="sort")


def test_an_unknown_total_is_reported_as_unknown_not_as_zero_percent() -> None:
    task = _task()

    task.update_progress(3)

    assert task.progress.total_known is False
    assert task.progress.percentage == 0.0
    assert task.progress.eta_confidence == "unknown"


def test_a_known_total_drives_percentage_and_eta_confidence() -> None:
    task = _task()

    task.update_progress(60, total=100, eta_seconds=12.0)

    assert task.progress.total_known is True
    assert task.progress.percentage == 60.0
    assert task.progress.eta_confidence == "high"


def test_eta_confidence_grows_with_evidence() -> None:
    task = _task()

    task.update_progress(5, total=100, eta_seconds=99.0)
    assert task.progress.eta_confidence == "low"

    task.update_progress(20, eta_seconds=80.0)
    assert task.progress.eta_confidence == "medium"


def test_an_eta_without_a_total_is_never_presented_as_confident() -> None:
    task = _task()

    task.update_progress(500, eta_seconds=1.0)

    assert task.progress.eta_confidence == "unknown"


def test_byte_counters_are_carried_alongside_item_counters() -> None:
    task = _task()

    task.update_progress(2, total=10, bytes_done=2048, bytes_total=10240, unit="bytes")

    assert task.progress.bytes_done == 2048
    assert task.progress.bytes_total_known is True
    assert task.progress.unit == "bytes"


def test_liveness_advances_on_every_update() -> None:
    task = _task()

    task.update_progress(1, total=10)
    first = task.progress.last_activity_at
    task.update_progress(2)

    assert first is not None
    assert task.progress.last_activity_at is not None
    assert task.progress.last_activity_at >= first


def test_checkpoints_record_where_a_restart_could_resume() -> None:
    task = _task()

    task.checkpoint("file:42")

    assert task.progress.last_checkpoint_label == "file:42"
    assert task.progress.last_checkpoint_at is not None
    assert [event.name for event in task.events][-1] == "operation.checkpoint"


def test_success_never_hides_failed_or_skipped_counts() -> None:
    task = _task()

    task.record_outcome("success", count=8)
    task.record_outcome("failed")
    task.record_outcome("duplicate", count=3)

    assert task.progress.outcomes == {"success": 8, "failed": 1, "duplicate": 3}


def test_cancellation_distinguishes_requested_from_observed() -> None:
    task = _task()
    assert task.progress.cancellation_requested is False

    task.progress.cancellation_requested = True
    assert task.progress.cancellation_observed_at is None

    task.observe_cancellation()
    first = task.progress.cancellation_observed_at
    task.observe_cancellation()

    assert first is not None
    assert task.progress.cancellation_observed_at == first


def test_recovery_is_reported_as_its_own_phase() -> None:
    task = _task()

    task.enter_recovery("reconciling")

    assert task.progress.recovery_phase == "reconciling"


def test_a_phase_change_keeps_outcomes_and_cancellation_state() -> None:
    task = _task()
    task.record_outcome("success", count=4)
    task.progress.cancellation_requested = True
    task.checkpoint("file:4")

    task.transition("sorting", total=20)

    assert task.progress.outcomes == {"success": 4}
    assert task.progress.cancellation_requested is True
    assert task.progress.last_checkpoint_label == "file:4"
    assert task.progress.total_known is True


def test_the_api_response_carries_every_honest_signal() -> None:
    task = _task()
    task.update_progress(5, total=50, eta_seconds=10.0, bytes_done=99)
    task.record_outcome("success", count=5)
    task.checkpoint("file:5")
    task.observe_cancellation()

    payload = TaskProgressResponse.from_task(task).model_dump()

    progress = payload["progress"]
    assert progress["total_known"] is True
    assert progress["eta_confidence"] == "low"
    assert progress["bytes_done"] == 99
    assert progress["outcomes"] == {"success": 5}
    assert progress["last_checkpoint_label"] == "file:5"
    assert progress["cancellation_observed_at"] is not None
    assert progress["last_activity_at"] is not None
