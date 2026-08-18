"""CLI transport and command behavior for long-running tasks."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest
from click.testing import CliRunner

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from cli.main import cli  # noqa: E402
from cli.utils.api_client import APIClient, APIClientError  # noqa: E402


def _response(request: httpx.Request, status: int, payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(status, request=request, content=json.dumps(payload).encode())


def test_client_sends_capability_from_environment() -> None:
    token = "headless-capability"
    with patch.dict(os.environ, {"MEDIASORT_API_CAPABILITY": token}):
        client = APIClient()
    request = client._http.build_request("GET", "/api/health")
    assert request.headers["X-MediaSorter-Capability"] == token
    client._http.close()


def test_cli_option_passes_capability_without_echoing_it() -> None:
    token = "option-capability"
    fake = MagicMock()
    fake.get_health.return_value = {"status": "ok"}
    with patch("cli.main.APIClient", return_value=fake) as client_class:
        result = CliRunner().invoke(
            cli,
            ["--api-capability", token, "health"],
        )
    assert result.exit_code == 0
    client_class.assert_called_once_with(
        "http://localhost:8000",
        capability=token,
    )
    assert token not in result.output


def test_start_retry_reuses_one_idempotency_key() -> None:
    attempts: list[dict[str, Any]] = []

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


class TestLiveSortHandshake:
    """C-03 at the CLI boundary.

    `mediasort sort start` sent `{"dry_run": false}` and nothing else. It was
    the one entry point that could mutate a whole library with no reviewed plan
    behind it — the interface offered no way to produce one. It now runs the
    preview itself and hands the resulting plan to the sort.
    """

    def _client(self) -> MagicMock:
        client = MagicMock(spec=APIClient)
        client.start_preview.return_value = "preview-task"
        client.get_preview_progress.return_value = {"status": "completed"}
        client.reviewed_plan_id.return_value = "plan-abc"
        client.start_sorting.return_value = "sort-task"
        return client

    def _invoke(self, client: MagicMock, *args: str) -> Any:
        # The group callback builds its own `APIClient`, so the constructor is
        # what has to be replaced — passing `obj=` would be overwritten.
        with patch("cli.main.APIClient", return_value=client):
            return CliRunner().invoke(cli, ["sort", "start", *args])

    def test_a_live_start_previews_first_and_passes_the_plan(self) -> None:
        client = self._client()

        result = self._invoke(client)

        assert result.exit_code == 0, result.output
        client.start_preview.assert_called_once()
        client.start_sorting.assert_called_once_with(dry_run=False, plan_id="plan-abc")
        assert "plan-abc" in result.output

    def test_a_dry_run_needs_no_preview(self) -> None:
        """A preview mutates nothing, so requiring a plan for it would be circular."""
        client = self._client()

        result = self._invoke(client, "--dry-run")

        assert result.exit_code == 0, result.output
        client.start_preview.assert_not_called()
        client.start_sorting.assert_called_once_with(dry_run=True, plan_id=None)

    def test_a_preview_that_yields_no_plan_starts_nothing(self) -> None:
        client = self._client()
        client.reviewed_plan_id.return_value = None

        result = self._invoke(client)

        assert result.exit_code == 1
        client.start_sorting.assert_not_called()

    def test_a_failed_preview_starts_nothing(self) -> None:
        client = self._client()
        client.get_preview_progress.return_value = {"status": "failed", "error": "disk gone"}

        result = self._invoke(client)

        assert result.exit_code == 1
        client.start_sorting.assert_not_called()


def _client_with(handler: Any) -> APIClient:
    client = APIClient()
    client._http.close()
    client._http = httpx.Client(
        base_url=client.base_url, transport=httpx.MockTransport(handler), timeout=0.1
    )
    return client


def test_the_api_client_omits_plan_id_when_there_is_none() -> None:
    """A dry run must not send `plan_id: null` and imply one was considered."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _response(request, 200, {"task_id": "t1"})

    with patch("cli.utils.api_client.time.sleep"):
        assert _client_with(handler).start_sorting(dry_run=True) == "t1"

    assert captured["dry_run"] is True
    assert "plan_id" not in captured


def test_the_api_client_sends_plan_id_for_a_live_run() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _response(request, 200, {"task_id": "t1"})

    with patch("cli.utils.api_client.time.sleep"):
        assert _client_with(handler).start_sorting(dry_run=False, plan_id="plan-abc") == "t1"

    assert captured["dry_run"] is False
    assert captured["plan_id"] == "plan-abc"


def test_the_reviewed_plan_id_helper_reads_the_preview_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _response(request, 200, {"status": "completed", "result": {"plan_id": "plan-xyz"}})

    with patch("cli.utils.api_client.time.sleep"):
        assert _client_with(handler).reviewed_plan_id("preview-task") == "plan-xyz"


def test_the_reviewed_plan_id_helper_returns_none_without_a_plan() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _response(request, 200, {"status": "completed", "result": {}})

    with patch("cli.utils.api_client.time.sleep"):
        assert _client_with(handler).reviewed_plan_id("preview-task") is None
