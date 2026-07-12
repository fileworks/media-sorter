"""Integration tests for the reports API routes."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = AppFactory.create(config=Config.defaults())
    return TestClient(app)


# ------------------------------------------------------------------ #
# GET /api/reports                                                        #
# ------------------------------------------------------------------ #


def test_list_reports_returns_200(client: TestClient) -> None:
    with patch(
        "app.services.report_service.ReportService.list_operations",
        new=AsyncMock(
            return_value={
                "operations": [],
                "total": 0,
                "limit": 20,
                "offset": 0,
            }
        ),
    ):
        response = client.get("/api/reports")

    assert response.status_code == 200
    data = response.json()
    assert "operations" in data
    assert "total" in data


def test_list_reports_respects_pagination(client: TestClient) -> None:
    with patch(
        "app.services.report_service.ReportService.list_operations",
        new=AsyncMock(
            return_value={
                "operations": [],
                "total": 0,
                "limit": 5,
                "offset": 10,
            }
        ),
    ):
        response = client.get("/api/reports?limit=5&offset=10")

    assert response.status_code == 200


# ------------------------------------------------------------------ #
# GET /api/reports/{operation_id}                                        #
# ------------------------------------------------------------------ #


def test_get_report_returns_200_for_existing_operation(
    client: TestClient, db_with_operation
) -> None:
    operation_id, _ = db_with_operation

    mock_report = {
        "operation_id": operation_id,
        "source_path": "/source",
        "dest_path": "/dest",
        "summary": {
            "total": 100,
            "sorted": 95,
            "failed": 3,
            "duplicates": 1,
            "future_dates": 0,
            "unknown_dates": 0,
            "corrupted": 0,
        },
        "files": [],
    }

    with patch(
        "app.services.report_service.ReportService.get_report",
        new=AsyncMock(return_value=mock_report),
    ):
        response = client.get(f"/api/reports/{operation_id}")

    assert response.status_code == 200
    data = response.json()
    assert data["operation_id"] == operation_id


def test_get_report_returns_404_for_unknown_id(client: TestClient) -> None:
    """Fix 6: missing operation_id must return HTTP 404, not empty body."""
    from app.core.exceptions import OperationNotFoundError

    with patch(
        "app.services.report_service.ReportService.get_report",
        new=AsyncMock(side_effect=OperationNotFoundError("nonexistent_op")),
    ):
        response = client.get("/api/reports/nonexistent_op")

    assert response.status_code == 404
    data = response.json()
    assert data["code"] == "OPERATION_NOT_FOUND"
    assert "error" in data


# ------------------------------------------------------------------ #
# POST /api/reports/{operation_id}/export                               #
# ------------------------------------------------------------------ #


def test_export_json_returns_streaming_response(client: TestClient, db_with_operation) -> None:
    operation_id, _ = db_with_operation
    export_data = json.dumps({"operation_id": operation_id, "files": []})

    with patch(
        "app.services.report_service.ReportService.export",
        new=AsyncMock(
            return_value=(export_data, "application/json", f"report_{operation_id}.json")
        ),
    ):
        response = client.post(
            f"/api/reports/{operation_id}/export",
            json={"format": "json"},
        )

    assert response.status_code == 200
    assert "application/json" in response.headers.get("content-type", "")


def test_export_csv_returns_streaming_response(client: TestClient, db_with_operation) -> None:
    operation_id, _ = db_with_operation
    csv_data = "source_path,dest_path,status\n/source,/dest,success\n"

    with patch(
        "app.services.report_service.ReportService.export",
        new=AsyncMock(return_value=(csv_data, "text/csv", f"report_{operation_id}.csv")),
    ):
        response = client.post(
            f"/api/reports/{operation_id}/export",
            json={"format": "csv"},
        )

    assert response.status_code == 200
    assert "text/csv" in response.headers.get("content-type", "")


def test_export_returns_404_for_unknown_id(client: TestClient) -> None:
    """Fix 6: export for unknown operation_id must return HTTP 404."""
    from app.core.exceptions import OperationNotFoundError

    with patch(
        "app.services.report_service.ReportService.export",
        new=AsyncMock(side_effect=OperationNotFoundError("bad_id")),
    ):
        response = client.post(
            "/api/reports/bad_id/export",
            json={"format": "json"},
        )

    assert response.status_code == 404
    data = response.json()
    assert data["code"] == "OPERATION_NOT_FOUND"


def test_export_content_disposition_header(client: TestClient, db_with_operation) -> None:
    operation_id, _ = db_with_operation
    filename = f"report_{operation_id}.json"

    with patch(
        "app.services.report_service.ReportService.export",
        new=AsyncMock(return_value=("{}", "application/json", filename)),
    ):
        response = client.post(
            f"/api/reports/{operation_id}/export",
            json={"format": "json"},
        )

    disposition = response.headers.get("content-disposition", "")
    assert filename in disposition


def test_export_exposes_content_disposition_header(client: TestClient, db_with_operation) -> None:
    operation_id, _ = db_with_operation
    with patch(
        "app.services.report_service.ReportService.export",
        new=AsyncMock(return_value=("{}", "application/json", f"report_{operation_id}.json")),
    ):
        response = client.post(
            f"/api/reports/{operation_id}/export",
            json={"format": "json"},
        )
    headers = {k.lower(): v for k, v in response.headers.items()}
    assert "content-disposition" in headers
    assert "attachment" in headers["content-disposition"]
