"""Every operation branch must produce a correlated, safe, terminated timeline.

These tests drive real placements and real recovery, then assert on what the
event stream says about them — the branch coverage that makes the taxonomy
trustworthy rather than decorative.
"""

from __future__ import annotations

import errno
import hashlib
from pathlib import Path

import pytest
from support import authorize_mutations

from app.core.action_journal import DurableActionJournal
from app.core.config import Config
from app.core.exceptions import IntegrityTransferError
from app.core.integrity import OperationEvent
from app.core.integrity_policy import authorize_config_mutations
from app.core.logging_config import logging_health
from app.services import verified_transfer
from app.services.operation_execution import OperationExecution
from app.services.reconciliation import apply_safe_recovery, reconcile_pending_operations

_CONFIG_DIGEST = hashlib.sha256(b"config").hexdigest()


def _execution(tmp_path: Path, *, config: Config | None = None) -> OperationExecution:
    settings = config or Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "sorted"),
    )
    return OperationExecution.start(
        operation_id="op_observability",
        state_root=tmp_path / "state",
        preservation=settings.preservation_profile,
        authorization=authorize_config_mutations(settings),
        effective_config_sha256=_CONFIG_DIGEST,
    )


def _codes(execution: OperationExecution) -> list[str]:
    assert execution.events is not None
    return [event.event_code for event in execution.events.events]


def _events(execution: OperationExecution) -> tuple[OperationEvent, ...]:
    assert execution.events is not None
    return execution.events.events


def _source(tmp_path: Path, name: str = "photo.jpg", data: bytes = b"media") -> Path:
    path = tmp_path / "source" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ------------------------------------------------------------------ #
# Happy path                                                          #
# ------------------------------------------------------------------ #


def test_a_successful_placement_produces_a_complete_ordered_timeline(tmp_path: Path) -> None:
    execution = _execution(tmp_path)
    source = _source(tmp_path)

    execution.place(
        source,
        tmp_path / "sorted" / "photo.jpg",
        kind="copy",
        move=False,
        root_id=str(tmp_path / "source"),
        relative_path="photo.jpg",
    )
    execution.finish("completed")

    codes = _codes(execution)
    assert codes[0] == "operation.started"
    assert "operation.authorized" in codes
    assert codes.index("action.authorized") < codes.index("action.outcome")
    assert codes[-1] == "operation.completed"
    assert [event.sequence for event in _events(execution)] == list(range(1, len(codes) + 1))


def test_every_event_of_a_run_shares_one_operation_id(tmp_path: Path) -> None:
    execution = _execution(tmp_path)
    execution.place(
        _source(tmp_path),
        tmp_path / "sorted" / "photo.jpg",
        kind="copy",
        move=False,
        root_id=str(tmp_path / "source"),
        relative_path="photo.jpg",
    )
    execution.finish("completed")

    assert {event.operation_id for event in _events(execution)} == {"op_observability"}
    assert {event.profile_id for event in _events(execution)} == {"organize-only"}


def test_action_events_correlate_to_the_manifest_action(tmp_path: Path) -> None:
    execution = _execution(tmp_path)

    result = execution.place(
        _source(tmp_path),
        tmp_path / "sorted" / "photo.jpg",
        kind="copy",
        move=False,
        root_id=str(tmp_path / "source"),
        relative_path="photo.jpg",
    )
    execution.finish("completed")

    action_events = [event for event in _events(execution) if event.action_id is not None]
    assert action_events
    assert {event.action_id for event in action_events} == {result.action_id}


# ------------------------------------------------------------------ #
# Failure and degradation branches                                     #
# ------------------------------------------------------------------ #


def test_a_degraded_commit_is_reported_as_its_own_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os

    execution = _execution(tmp_path)

    def unsupported_link(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.EOPNOTSUPP, "hard links unavailable")

    monkeypatch.setattr(os, "link", unsupported_link)

    execution.place(
        _source(tmp_path),
        tmp_path / "sorted" / "photo.jpg",
        kind="copy",
        move=False,
        root_id=str(tmp_path / "source"),
        relative_path="photo.jpg",
    )
    execution.finish("completed_with_warnings")

    degraded = [event for event in _events(execution) if event.event_code == "transfer.degraded"]
    assert len(degraded) == 1
    assert degraded[0].severity == "warning"
    assert degraded[0].context["reason"] == "atomic_no_clobber_publication_unavailable"


def test_a_failed_placement_still_reaches_exactly_one_terminal_event(tmp_path: Path) -> None:
    execution = _execution(tmp_path)
    source = _source(tmp_path)
    blocker = tmp_path / "sorted" / "photo.jpg"
    blocker.parent.mkdir(parents=True)
    blocker.write_bytes(b"already here")

    with pytest.raises(IntegrityTransferError):
        execution.place(
            source,
            blocker,
            kind="copy",
            move=False,
            root_id=str(tmp_path / "source"),
            relative_path="photo.jpg",
        )
    execution.finish("failed")

    codes = _codes(execution)
    assert codes.count("operation.failed") == 1
    assert len([code for code in codes if code.startswith("operation.")]) >= 3
    assert execution.events is not None
    assert execution.events.terminal is not None


def test_a_missing_journal_is_reported_as_degraded_diagnostics(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.EACCES, "state directory is read-only")

    monkeypatch.setattr(DurableActionJournal, "open_operation", refuse)

    execution = _execution(tmp_path)

    assert execution.journal is None
    assert "logging.degraded" in _codes(execution)


def test_recovery_emits_a_correlated_terminated_timeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[OperationEvent] = []
    monkeypatch.setattr(
        "app.services.reconciliation.structlog_sink",
        lambda _logger: published.append,
    )
    execution = _execution(tmp_path)
    source = _source(tmp_path, data=b"interrupted")
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def crash(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt("power loss")

    monkeypatch.setattr(verified_transfer, "_remove_verified_source", crash)
    with pytest.raises(KeyboardInterrupt):
        execution.place(
            source,
            tmp_path / "sorted" / "photo.jpg",
            kind="move",
            move=True,
            root_id=str(tmp_path / "source"),
            relative_path="photo.jpg",
        )
    assert execution.journal is not None
    execution.journal.close()
    monkeypatch.undo()
    monkeypatch.setattr(
        "app.services.reconciliation.structlog_sink",
        lambda _logger: published.append,
    )

    (report,) = reconcile_pending_operations(tmp_path / "state")
    apply_safe_recovery(tmp_path / "state", report)

    codes = [event.event_code for event in published]
    assert codes[0] == "recovery.scanned"
    assert "recovery.reconciled" in codes
    assert codes[-1] in {"operation.completed", "operation.partial"}
    assert {event.operation_id for event in published} == {"op_observability"}


def test_recovery_that_needs_a_person_says_so(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[OperationEvent] = []
    monkeypatch.setattr(
        "app.services.reconciliation.structlog_sink",
        lambda _logger: published.append,
    )
    execution = _execution(tmp_path)
    source = _source(tmp_path, data=b"authorized content")
    action_destination = tmp_path / "sorted" / "photo.jpg"
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def crash(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt("power loss")

    monkeypatch.setattr(verified_transfer, "commit_staged", crash)
    with pytest.raises(KeyboardInterrupt):
        execution.place(
            source,
            action_destination,
            kind="move",
            move=True,
            root_id=str(tmp_path / "source"),
            relative_path="photo.jpg",
        )
    assert execution.journal is not None
    execution.journal.close()
    monkeypatch.undo()
    monkeypatch.setattr(
        "app.services.reconciliation.structlog_sink",
        lambda _logger: published.append,
    )
    action_destination.parent.mkdir(parents=True, exist_ok=True)
    action_destination.write_bytes(b"somebody else's file")

    (report,) = reconcile_pending_operations(tmp_path / "state")
    apply_safe_recovery(tmp_path / "state", report)

    codes = [event.event_code for event in published]
    assert "recovery.review_required" in codes
    assert codes[-1] == "operation.partial"
    assert source.read_bytes() == b"authorized content"


# ------------------------------------------------------------------ #
# Privacy across the whole pipeline                                    #
# ------------------------------------------------------------------ #


def test_no_real_path_or_filename_survives_into_the_event_stream(tmp_path: Path) -> None:
    execution = _execution(tmp_path)
    source = _source(tmp_path, name="Tax Return 2019 SSN.jpg")

    execution.place(
        source,
        tmp_path / "sorted" / "Tax Return 2019 SSN.jpg",
        kind="copy",
        move=False,
        root_id=str(tmp_path / "source"),
        relative_path="Tax Return 2019 SSN.jpg",
    )
    execution.finish("completed")

    rendered = "".join(event.model_dump_json() for event in _events(execution))
    assert "Tax Return 2019 SSN" not in rendered
    assert str(tmp_path) not in rendered


def test_credentials_in_the_effective_config_never_reach_the_event_stream(
    tmp_path: Path,
) -> None:
    config = Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "sorted"),
        ai_tagging_api_key="sk-live-should-never-appear",
    )
    authorize_mutations(config, embedded_metadata=True)

    execution = _execution(tmp_path, config=config)
    execution.emit("operation.preflight", settings=config.to_dict())
    execution.finish("completed")

    rendered = "".join(event.model_dump_json() for event in _events(execution))
    assert "sk-live-should-never-appear" not in rendered


# ------------------------------------------------------------------ #
# Logging health                                                       #
# ------------------------------------------------------------------ #


def test_logging_health_reports_location_rotation_and_sinks() -> None:
    health = logging_health()

    assert set(health) >= {
        "log_directory",
        "level",
        "handlers",
        "file_logging_active",
        "rotation",
        "dropped_live_events",
        "sink_failures",
        "degraded",
    }
    assert health["rotation"]["backup_count"] >= 1
    assert isinstance(health["dropped_live_events"], int)


def test_a_persistent_sink_failure_is_visible_rather_than_swallowed() -> None:
    from app.core import logging_config

    before = len(logging_config.logging_health()["sink_failures"])
    logging_config.record_sink_failure("test_sink:Boom")

    health = logging_config.logging_health()

    assert "test_sink:Boom" in health["sink_failures"]
    assert health["degraded"] is True
    assert len(health["sink_failures"]) >= before


def test_the_diagnostics_endpoint_reports_state_without_content(client: object) -> None:
    response = client.get("/api/diagnostics")  # type: ignore[attr-defined]

    assert response.status_code == 200
    payload = response.json()
    assert payload["version"]
    assert "rotation" in payload["logging"]
    assert isinstance(payload["operations_needing_review"], list)
    assert isinstance(payload["recovery_operations"], list)
    assert "message" not in payload["logging"]
