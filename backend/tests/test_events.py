"""Contract and privacy tests for the shared operation-event vocabulary.

These are deliberately strict. An event that loses its correlation, invents a
code, concludes an operation twice, or leaks a credential is a defect the
moment it is emitted, not when someone reads a log.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.core.events import (
    EVENT_REGISTRY,
    REDACTED,
    TERMINAL_EVENT_BY_OUTCOME,
    EventContractError,
    EventRecorder,
    PathTokenizer,
    definition,
    sanitize_context,
)
from app.core.integrity import OperationEvent

_SECRET = "sk-live-0123456789abcdef"


def _recorder(**kwargs: object) -> EventRecorder:
    return EventRecorder(
        "op_test",
        task_id="task_test",
        plan_id="plan_test",
        profile_id="organize-only",
        **kwargs,
    )


# ------------------------------------------------------------------ #
# Registry contract                                                    #
# ------------------------------------------------------------------ #


def test_every_declared_code_is_self_consistent() -> None:
    for code, declared in EVENT_REGISTRY.items():
        assert declared.code == code
        assert declared.message_key, f"{code} has no message key"
        assert declared.severity in {"debug", "info", "warning", "error", "critical"}
        assert declared.privacy in {"public", "operational", "path", "media_metadata", "secret"}
        assert declared.privacy != "secret", f"{code} must not be classified as secret"


def test_exactly_one_terminal_code_exists_per_operation_outcome() -> None:
    terminal = {code for code, declared in EVENT_REGISTRY.items() if declared.terminal}

    assert terminal == set(TERMINAL_EVENT_BY_OUTCOME.values())
    assert len(TERMINAL_EVENT_BY_OUTCOME) == len(terminal)


def test_unknown_codes_are_refused_rather_than_invented() -> None:
    with pytest.raises(EventContractError, match="Unknown event code"):
        definition("operation.probably_fine")
    with pytest.raises(EventContractError):
        _recorder().emit("operation.probably_fine")


# ------------------------------------------------------------------ #
# Correlation                                                         #
# ------------------------------------------------------------------ #


def test_every_event_carries_the_full_correlation_chain() -> None:
    recorder = _recorder()

    event = recorder.emit("action.outcome", action_id="act_1", phase="executing")

    assert event.operation_id == "op_test"
    assert event.task_id == "task_test"
    assert event.plan_id == "plan_test"
    assert event.profile_id == "organize-only"
    assert event.action_id == "act_1"
    assert event.phase == "executing"
    assert event.severity == EVENT_REGISTRY["action.outcome"].severity
    assert event.message_key == EVENT_REGISTRY["action.outcome"].message_key


def test_sequences_are_contiguous_and_ordered() -> None:
    recorder = _recorder()

    for _ in range(5):
        recorder.emit("operation.checkpoint")

    assert [event.sequence for event in recorder.events] == [1, 2, 3, 4, 5]


def test_an_operation_concludes_exactly_once() -> None:
    recorder = _recorder()
    recorder.emit("operation.started")

    recorder.conclude("completed")

    assert recorder.terminal is not None
    assert recorder.terminal.event_code == "operation.completed"
    with pytest.raises(EventContractError, match="already concluded"):
        recorder.emit("operation.checkpoint")
    with pytest.raises(EventContractError, match="already concluded"):
        recorder.conclude("failed")


def test_unknown_outcomes_cannot_conclude_an_operation() -> None:
    with pytest.raises(EventContractError, match="Unknown operation outcome"):
        _recorder().conclude("mostly_fine")


def test_events_reach_the_sink_in_order() -> None:
    published: list[OperationEvent] = []
    recorder = _recorder(sink=published.append)

    recorder.emit("operation.started")
    recorder.conclude("cancelled")

    assert [event.event_code for event in published] == [
        "operation.started",
        "operation.cancelled",
    ]


def test_a_broken_sink_never_breaks_the_operation() -> None:
    def explode(_event: OperationEvent) -> None:
        raise RuntimeError("sink is down")

    recorder = _recorder(sink=explode)

    event = recorder.emit("operation.started")

    assert event.sequence == 1
    assert recorder.events


# ------------------------------------------------------------------ #
# Privacy                                                             #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "key",
    [
        "api_key",
        "ai_tagging_api_key",
        "authorization",
        "Cookie",
        "password",
        "refresh_token",
        "client_secret",
        "credential_bundle",
    ],
)
def test_credential_like_values_never_reach_an_event(key: str) -> None:
    event = _recorder().emit("operation.started", **{key: _SECRET})

    assert event.context[key] == REDACTED
    assert _SECRET not in str(event.model_dump())


def test_nested_credentials_are_redacted_too() -> None:
    event = _recorder().emit(
        "operation.started",
        settings={"provider": "azure", "api_key": _SECRET, "nested": {"token": _SECRET}},
    )

    assert _SECRET not in str(event.context)
    assert event.context["settings"]["api_key"] == REDACTED  # type: ignore[index]


def test_paths_and_filenames_are_tokenized_not_published(tmp_path: Path) -> None:
    source = tmp_path / "Private Holidays" / "IMG_secret_name.jpg"

    event = _recorder().emit("action.outcome", source_path=str(source), phase="executing")

    token = event.context["source_path"]
    assert isinstance(token, str)
    assert "IMG_secret_name" not in token
    assert "Private Holidays" not in token
    assert str(tmp_path) not in token
    assert token.startswith("<root")


def test_tokenized_paths_keep_the_root_relationship(tmp_path: Path) -> None:
    tokenizer = PathTokenizer()

    first = tokenizer.token(tmp_path / "a" / "one.jpg")
    second = tokenizer.token(tmp_path / "b" / "two.jpg")
    other = tokenizer.token("relative/elsewhere.jpg")

    assert first.split("/")[0] == second.split("/")[0]
    assert other.split("/")[0] != first.split("/")[0]
    assert first != second


def test_the_same_name_tokenizes_stably() -> None:
    tokenizer = PathTokenizer()

    assert tokenizer.token("/library/photo.jpg") == tokenizer.token("/library/photo.jpg")


def test_root_ids_are_tokenized_as_well(tmp_path: Path) -> None:
    event = _recorder().emit("action.outcome", root_id=str(tmp_path / "Family Archive"))

    assert event.root_id is not None
    assert "Family Archive" not in event.root_id


def test_media_bytes_are_never_carried_in_an_event() -> None:
    payload = b"\xff\xd8\xff\xe0JFIF-actual-media-bytes"

    event = _recorder().emit("action.outcome", sample=payload)

    assert event.context["sample"] == f"<{len(payload)} bytes>"
    assert "JFIF" not in str(event.context)


def test_unserializable_objects_are_reduced_to_their_type() -> None:
    class Opaque:
        def __str__(self) -> str:  # pragma: no cover - must not be called
            raise AssertionError("event context must not stringify arbitrary objects")

    event = _recorder().emit("operation.started", thing=Opaque())

    assert event.context["thing"] == "<Opaque>"


def test_metadata_values_are_kept_but_paths_inside_them_are_not(tmp_path: Path) -> None:
    context = sanitize_context(
        {"camera": "Pixel 8", "file_path": str(tmp_path / "DCIM" / "raw.dng")},
        tokenizer=PathTokenizer(),
    )

    assert context["camera"] == "Pixel 8"
    assert "raw.dng" not in str(context["file_path"])


def test_an_event_is_json_serializable_for_every_surface() -> None:
    event = _recorder().emit(
        "action.outcome",
        action_id="act_1",
        source_path="/library/a.jpg",
        counts={"ok": 1},
        ratio=0.5,
        cancelled=False,
        missing=None,
    )

    payload = event.model_dump_json()

    assert "act_1" in payload
    assert hashlib.sha256(b"a.jpg").hexdigest()[:12] in payload
