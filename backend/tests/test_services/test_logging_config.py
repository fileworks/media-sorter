"""Tests for LogQueueBroadcast and _to_jsonable in logging_config.py."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from app.core.logging_config import LogQueueBroadcast, _to_jsonable

# ------------------------------------------------------------------ #
# _to_jsonable                                                          #
# ------------------------------------------------------------------ #


def test_to_jsonable_primitives() -> None:
    assert _to_jsonable("hello") == "hello"
    assert _to_jsonable(42) == 42
    assert _to_jsonable(3.14) == 3.14
    assert _to_jsonable(True) is True
    assert _to_jsonable(None) is None


def test_to_jsonable_path() -> None:
    result = _to_jsonable(Path("/some/file.jpg"))
    assert isinstance(result, str)
    assert "/some/file.jpg" in result


def test_to_jsonable_exception() -> None:
    exc = ValueError("something went wrong")
    result = _to_jsonable(exc)
    assert isinstance(result, str)
    assert "something went wrong" in result


def test_to_jsonable_bytes() -> None:
    result = _to_jsonable(b"\xff\xd8\xff")
    assert isinstance(result, str)


def test_to_jsonable_list_with_path() -> None:
    result = _to_jsonable([Path("/a"), Path("/b")])
    assert isinstance(result, list)
    assert all(isinstance(x, str) for x in result)


def test_to_jsonable_dict_with_non_str_key() -> None:
    result = _to_jsonable({1: "one", 2: Path("/two")})
    assert isinstance(result, dict)
    assert "1" in result
    assert isinstance(result["2"], str)


def test_to_jsonable_nested() -> None:
    result = _to_jsonable({"path": Path("/x"), "error": ValueError("oops")})
    assert isinstance(result["path"], str)
    assert isinstance(result["error"], str)
    assert "oops" in result["error"]


# ------------------------------------------------------------------ #
# LogQueueBroadcast                                                     #
# ------------------------------------------------------------------ #


def test_log_queue_broadcast_carries_context_fields() -> None:
    """Extra kwargs (path=Path(...), error=Exception(...)) appear in context as
    JSON-safe strings."""
    broadcast = LogQueueBroadcast()

    event_dict = {
        "event": "File processed",
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "info",
        "path": Path("/some/photo.jpg"),
        "error": Exception("boom"),
    }

    captured: list = []

    with patch("app.core.log_queue.get_queue") as mock_get_queue:
        q = MagicMock()
        q.put_nowait.side_effect = lambda entry: captured.append(entry)
        mock_get_queue.return_value = q

        broadcast(MagicMock(), "info", event_dict)

    assert len(captured) == 1
    entry = captured[0]
    assert entry["message"] == "File processed"
    assert entry["level"] == "info"
    assert entry["context"] is not None

    # path and error must be JSON-safe strings in context
    assert "path" in entry["context"]
    assert isinstance(entry["context"]["path"], str)
    assert "error" in entry["context"]
    assert isinstance(entry["context"]["error"], str)
    assert "boom" in entry["context"]["error"]


def test_log_queue_broadcast_reserved_keys_excluded_from_context() -> None:
    """'event', 'timestamp', 'level', 'logger', 'level_number' must NOT appear in context."""
    broadcast = LogQueueBroadcast()

    event_dict = {
        "event": "Something happened",
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "warning",
        "logger": "app.services.sorting",
        "level_number": 30,
        "operation_id": "sort_abc123",
    }

    captured: list = []

    with patch("app.core.log_queue.get_queue") as mock_get_queue:
        q = MagicMock()
        q.put_nowait.side_effect = lambda entry: captured.append(entry)
        mock_get_queue.return_value = q

        broadcast(MagicMock(), "warning", event_dict)

    entry = captured[0]
    context = entry["context"]
    assert "event" not in context
    assert "timestamp" not in context
    assert "level" not in context
    assert "logger" not in context
    assert "level_number" not in context
    # non-reserved extra field IS present
    assert "operation_id" in context


def test_log_queue_broadcast_no_extra_context_is_none() -> None:
    """When there are no extra fields, context should be None (not an empty dict)."""
    broadcast = LogQueueBroadcast()

    event_dict = {
        "event": "Ping",
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "debug",
    }

    captured: list = []

    with patch("app.core.log_queue.get_queue") as mock_get_queue:
        q = MagicMock()
        q.put_nowait.side_effect = lambda entry: captured.append(entry)
        mock_get_queue.return_value = q

        broadcast(MagicMock(), "debug", event_dict)

    assert captured[0]["context"] is None


def test_log_queue_broadcast_returns_event_dict_unchanged() -> None:
    """The processor must return the original event_dict (structlog chain contract)."""
    broadcast = LogQueueBroadcast()

    event_dict = {"event": "hello", "timestamp": "t", "level": "info", "extra_key": "val"}

    with patch("app.core.log_queue.get_queue"):
        result = broadcast(MagicMock(), "info", event_dict)

    assert result is event_dict
