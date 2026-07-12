"""Tests for app.core.serializers (Bug L8)."""

from __future__ import annotations

from app.core.serializers import serialize_file_operation


def test_suspicious_coerced_to_bool() -> None:
    assert serialize_file_operation({"suspicious": 1})["suspicious"] is True
    assert serialize_file_operation({"suspicious": 0})["suspicious"] is False
    # Missing column defaults to False rather than raising.
    assert serialize_file_operation({})["suspicious"] is False


def test_tags_split_into_list() -> None:
    assert serialize_file_operation({"tags": "a,b,c"})["tags"] == ["a", "b", "c"]
    assert serialize_file_operation({"tags": ""})["tags"] == []
    assert serialize_file_operation({"tags": None})["tags"] == []


def test_legacy_csv_tags_are_stripped() -> None:
    """Old rows were often written as "beach, sunset" — tokens must be trimmed."""
    assert serialize_file_operation({"tags": "beach, sunset"})["tags"] == ["beach", "sunset"]
    assert serialize_file_operation({"tags": " a , , b "})["tags"] == ["a", "b"]


def test_does_not_mutate_input() -> None:
    row = {"suspicious": 1, "tags": "x"}
    serialize_file_operation(row)
    assert row["suspicious"] == 1
    assert row["tags"] == "x"


def test_preserves_other_fields() -> None:
    out = serialize_file_operation({"source_path": "/a", "status": "success", "suspicious": 0})
    assert out["source_path"] == "/a"
    assert out["status"] == "success"
