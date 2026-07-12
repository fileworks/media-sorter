"""Tests for ReportService — get_report, list_operations, and export."""

from __future__ import annotations

import json

import pytest

from app.services.report_service import ReportService


@pytest.fixture()
def report_service(db_with_operation):  # type: ignore[return]
    operation_id, test_db = db_with_operation
    return ReportService(db_manager=test_db), operation_id


# ------------------------------------------------------------------ #
# get_report — new data contract                                        #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_get_report_returns_operation_id(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    report = await svc.get_report(operation_id)

    assert report["operation_id"] == operation_id


@pytest.mark.asyncio
async def test_get_report_returns_source_and_dest(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    report = await svc.get_report(operation_id)

    assert report["source_path"] == "/source"
    assert report["dest_path"] == "/dest"


@pytest.mark.asyncio
async def test_get_report_returns_summary(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    report = await svc.get_report(operation_id)

    summary = report["summary"]
    assert summary["total"] == 100
    assert summary["sorted"] == 95
    assert "failed" in summary
    assert "duplicates" in summary
    assert "future_dates" in summary
    assert "unknown_dates" in summary
    assert "corrupted" in summary
    # P0-engine outcome buckets are surfaced too (0 when the features are off).
    assert "junk" in summary
    assert "already_in_destination" in summary


@pytest.mark.asyncio
async def test_get_report_includes_files(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    report = await svc.get_report(operation_id)

    files = report["files"]
    assert len(files) == 2
    assert any(f["status"] == "success" for f in files)
    assert any(f["status"] == "unknown_date" for f in files)


@pytest.mark.asyncio
async def test_get_report_files_have_tags_list(report_service) -> None:  # type: ignore[return]
    """Each file entry has a 'tags' field that is a list."""
    svc, operation_id = report_service
    report = await svc.get_report(operation_id)

    for f in report["files"]:
        assert "tags" in f
        assert isinstance(f["tags"], list)


# ------------------------------------------------------------------ #
# suspicious flag round-trip (Cycle 2 — dead-UI contract fix)           #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_get_report_suspicious_flag_is_real_bool(db_with_operation) -> None:
    """The stored 0/1 suspicious flag is surfaced as a Python bool.

    The frontend keys on `f.suspicious === true`, and in JS `1 === true` is
    False — so the report must return real booleans, not SQLite's 0/1 ints.
    """
    operation_id, test_db = db_with_operation
    with test_db._connect() as conn:
        conn.execute(
            """
            INSERT INTO file_operations
                (id, operation_id, source_path, dest_path, extracted_date,
                 metadata_source, action, status, error_message, file_size,
                 file_type, suspicious)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "file_op_susp",
                operation_id,
                "/source/clock_reset.jpg",
                "/dest/2000/01/clock_reset.jpg",
                "2000-01-01",
                "filename",
                "copy",
                "success",
                "Suspicious EXIF: year before 2000",
                2048,
                ".jpg",
                1,
            ),
        )

    svc = ReportService(db_manager=test_db)
    report = await svc.get_report(operation_id)

    by_id = {f["id"]: f for f in report["files"]}
    assert by_id["file_op_susp"]["suspicious"] is True
    # The pre-seeded non-suspicious records must read back as a real False.
    assert by_id["file_op_001"]["suspicious"] is False


@pytest.mark.asyncio
async def test_export_csv_includes_suspicious_column(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, _, _ = await svc.export(operation_id, "csv")
    header = content.splitlines()[0]
    assert "suspicious" in header


# ------------------------------------------------------------------ #
# Fix 6 regression: 404 for missing operation                          #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_get_report_raises_for_unknown_id(db_with_operation) -> None:
    """get_report raises OperationNotFoundError for an unknown operation_id."""
    from app.core.exceptions import OperationNotFoundError

    _, test_db = db_with_operation
    svc = ReportService(db_manager=test_db)
    with pytest.raises(OperationNotFoundError, match="not found"):
        await svc.get_report("nonexistent_id")


# ------------------------------------------------------------------ #
# export — JSON                                                          #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_export_json_is_valid_json(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, media_type, filename = await svc.export(operation_id, "json")

    data = json.loads(content)
    assert data["operation_id"] == operation_id
    assert "files" in data
    assert media_type == "application/json"
    assert filename.endswith(".json")


@pytest.mark.asyncio
async def test_export_json_contains_operation_id(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, _, _ = await svc.export(operation_id, "json")
    assert operation_id in content


@pytest.mark.asyncio
async def test_export_raises_for_unknown_id(db_with_operation) -> None:
    """export raises OperationNotFoundError for an unknown operation_id."""
    from app.core.exceptions import OperationNotFoundError

    _, test_db = db_with_operation
    svc = ReportService(db_manager=test_db)
    with pytest.raises(OperationNotFoundError, match="not found"):
        await svc.export("no_such_op", "json")


# ------------------------------------------------------------------ #
# export — CSV                                                           #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_export_csv_has_correct_media_type(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, media_type, filename = await svc.export(operation_id, "csv")

    assert media_type == "text/csv"
    assert filename.endswith(".csv")


@pytest.mark.asyncio
async def test_export_csv_contains_header_row(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, _, _ = await svc.export(operation_id, "csv")

    # CSV should have a header line
    lines = [line for line in content.splitlines() if line.strip()]
    assert len(lines) >= 1
    header = lines[0]
    assert "source_path" in header


@pytest.mark.asyncio
async def test_export_csv_has_data_rows(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    content, _, _ = await svc.export(operation_id, "csv")

    lines = [line for line in content.splitlines() if line.strip()]
    # header + at least 2 file_operation rows
    assert len(lines) >= 3


# ------------------------------------------------------------------ #
# Filename conventions                                                   #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_export_filename_includes_operation_id(report_service) -> None:  # type: ignore[return]
    svc, operation_id = report_service
    _, _, json_filename = await svc.export(operation_id, "json")
    _, _, csv_filename = await svc.export(operation_id, "csv")

    assert operation_id in json_filename
    assert operation_id in csv_filename


# ------------------------------------------------------------------ #
# list_operations                                                        #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_list_operations_returns_paginated_result(db_with_operation) -> None:
    _, test_db = db_with_operation
    svc = ReportService(db_manager=test_db)
    result = await svc.list_operations(limit=10, offset=0)

    assert "operations" in result
    assert "total" in result
    assert "limit" in result
    assert "offset" in result
    assert result["total"] >= 1
    assert result["limit"] == 10
    assert result["offset"] == 0


@pytest.mark.asyncio
async def test_list_operations_includes_inserted_operation(db_with_operation) -> None:
    operation_id, test_db = db_with_operation
    svc = ReportService(db_manager=test_db)
    result = await svc.list_operations()

    ids = [op["id"] for op in result["operations"]]
    assert operation_id in ids
