"""CLI transport and command behavior for long-running tasks."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest
from click.testing import CliRunner

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from cli.main import cli  # noqa: E402
from cli.utils.api_client import APIClient, APIClientError  # noqa: E402


def _response(request: httpx.Request, status: int, payload: dict) -> httpx.Response:
    return httpx.Response(status, request=request, content=json.dumps(payload).encode())


def test_start_retry_reuses_one_idempotency_key() -> None:
    attempts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(json.loads(request.content))
        if len(attempts) == 1:
            raise httpx.ReadTimeout("lost", request=request)
        return _response(request, 200, {"task_id": "task-1"})

    client = APIClient()
    client._http.close()
    client._http = httpx.Client(
        base_url=client.base_url,
        transport=httpx.MockTransport(handler),
        timeout=0.1,
    )
    with patch("cli.utils.api_client.time.sleep"):
        assert client.start_scan("stable") == "task-1"
    assert [body["idempotency_key"] for body in attempts] == ["stable", "stable"]


def test_status_timeout_retries_poll_without_starting_again() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if len(paths) == 1:
            raise httpx.ReadTimeout("slow poll", request=request)
        assert request.headers["X-MediaSorter-Retry-Attempt"] == "1"
        return _response(
            request,
            200,
            {
                "task_id": "task-1",
                "status": "running",
                "last_event_sequence": 9,
            },
        )

    client = APIClient()
    client._http.close()
    client._http = httpx.Client(
        base_url=client.base_url,
        transport=httpx.MockTransport(handler),
    )
    with patch("cli.utils.api_client.time.sleep"):
        status = client.get_scan_progress("task-1", after_sequence=8)
    assert status["status"] == "running"
    assert paths == ["/api/scan/task-1", "/api/scan/task-1"]


def test_cancel_timeout_retries_only_the_cancel_request() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if len(paths) == 1:
            raise httpx.ReadTimeout("slow cancel", request=request)
        return _response(
            request,
            200,
            {
                "task_id": "task-1",
                "status": "running",
                "cancellation_requested": True,
            },
        )

    client = APIClient()
    client._http.close()
    client._http = httpx.Client(
        base_url=client.base_url,
        transport=httpx.MockTransport(handler),
    )
    with patch("cli.utils.api_client.time.sleep"):
        result = client.cancel_scan("task-1")
    assert result["cancellation_requested"] is True
    assert paths == ["/api/scan/task-1/cancel", "/api/scan/task-1/cancel"]


def test_active_task_conflict_is_actionable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _response(
            request,
            409,
            {
                "error": "An analysis operation is already active.",
                "code": "CONFLICT",
                "details": {
                    "active_task_id": "active-1",
                    "active_operation_kind": "analysis",
                },
            },
        )

    client = APIClient()
    client._http.close()
    client._http = httpx.Client(
        base_url=client.base_url,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(APIClientError, match="active analysis task: active-1"):
        client.start_preview("new")


def test_scan_command_polls_phases_and_surfaces_partial_result() -> None:
    fake = MagicMock()
    fake.start_scan.return_value = "scan-1"
    fake.get_scan_progress.side_effect = [
        {
            "status": "running",
            "progress": {"phase": "scanning_source"},
            "last_event_sequence": 2,
        },
        {
            "status": "completed",
            "progress": {"phase": "scanning_source"},
            "last_event_sequence": 3,
            "partial": True,
            "issues": [{"path": "/offline", "error_class": "OSError"}],
            "result": {
                "total": 0,
                "files": [],
                "excluded_files": 2,
                "partial": True,
                "issues": [],
            },
        },
    ]
    with (
        patch("cli.main.APIClient", return_value=fake),
        patch("cli.main.time.sleep"),
    ):
        result = CliRunner().invoke(cli, ["scan"])
    assert result.exit_code == 0
    assert "Scanning source" in result.output
    assert "Found 0 media file(s)" in result.output
    assert "result is partial" in result.output
    fake.start_scan.assert_called_once()


def test_analysis_command_surfaces_cancelled_terminal_state() -> None:
    fake = MagicMock()
    fake.start_analysis.return_value = "analysis-1"
    fake.get_analysis_progress.return_value = {
        "status": "cancelled",
        "progress": {"phase": "analyzing"},
        "last_event_sequence": 2,
    }
    with patch("cli.main.APIClient", return_value=fake):
        result = CliRunner().invoke(cli, ["analyze"])
    assert result.exit_code == 1
    assert "Analysis was cancelled" in result.output
    fake.start_analysis.assert_called_once()


def test_analysis_command_surfaces_actionable_source_failure() -> None:
    fake = MagicMock()
    fake.start_analysis.return_value = "analysis-1"
    fake.get_analysis_progress.return_value = {
        "status": "failed",
        "progress": {"phase": "validating"},
        "last_event_sequence": 2,
        "failure": {
            "code": "SOURCE_UNAVAILABLE",
            "message": "Source folder is unavailable; check that the drive is mounted.",
        },
    }
    with patch("cli.main.APIClient", return_value=fake):
        result = CliRunner().invoke(cli, ["analyze"])
    assert result.exit_code == 1
    assert "check that the drive is mounted" in result.output
    assert "SOURCE_UNAVAILABLE" in result.output
