"""Integration tests for the sorting API routes."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.background_tasks.task_manager import Task
from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = AppFactory.create(config=Config.defaults())
    return TestClient(app)


# ------------------------------------------------------------------ #
# POST /api/sorting/start                                               #
# ------------------------------------------------------------------ #


def test_start_sorting_returns_task_id(client: TestClient) -> None:
    response = client.post("/api/sorting/start", json={"dry_run": True})
    assert response.status_code == 200
    data = response.json()
    assert "task_id" in data
    assert isinstance(data["task_id"], str)
    assert len(data["task_id"]) > 0


def test_start_sorting_dry_run_flag_accepted(client: TestClient) -> None:
    response = client.post("/api/sorting/start", json={"dry_run": False})
    assert response.status_code == 200
    assert "task_id" in response.json()


def test_start_sorting_default_not_dry_run(client: TestClient) -> None:
    response = client.post("/api/sorting/start", json={})
    assert response.status_code == 200


# ------------------------------------------------------------------ #
# GET /api/sorting/{task_id}                                            #
# ------------------------------------------------------------------ #


def test_get_sorting_progress_valid_task(client: TestClient) -> None:
    # Start a task first
    start = client.post("/api/sorting/start", json={"dry_run": True})
    task_id = start.json()["task_id"]

    response = client.get(f"/api/sorting/{task_id}")
    assert response.status_code == 200

    data = response.json()
    assert data["task_id"] == task_id
    assert data["status"] in ("pending", "running", "completed", "failed", "cancelled")
    assert "progress" in data
    assert "current" in data["progress"]
    assert "total" in data["progress"]
    assert "percentage" in data["progress"]


def test_get_sorting_progress_unknown_task(client: TestClient) -> None:
    response = client.get("/api/sorting/nonexistent-task-id-xyz")
    # Should return a 4xx error
    assert response.status_code >= 400


# ------------------------------------------------------------------ #
# POST /api/sorting/{task_id}/cancel                                    #
# ------------------------------------------------------------------ #


def test_cancel_sorting_unknown_task(client: TestClient) -> None:
    response = client.post("/api/sorting/nonexistent-cancel-id/cancel")
    assert response.status_code >= 400


def test_cancel_sorting_valid_task(client: TestClient) -> None:
    start = client.post("/api/sorting/start", json={"dry_run": True})
    task_id = start.json()["task_id"]

    response = client.post(f"/api/sorting/{task_id}/cancel")
    assert response.status_code == 200
    # The task may complete before the cancel fires (especially in fast test env);
    # the route returns the actual task status rather than always "cancelled".
    assert response.json()["status"] in ("cancelled", "completed", "failed")


# ------------------------------------------------------------------ #
# GET /api/sorting/{task_id}/report                                     #
# ------------------------------------------------------------------ #


def test_get_sorting_report_unknown_task(client: TestClient) -> None:
    response = client.get("/api/sorting/nonexistent-report-id/report")
    assert response.status_code >= 400


def test_get_sorting_report_returns_result_when_completed(client: TestClient) -> None:
    """A completed task's report is returned verbatim with 200.

    Driven through the task manager directly: a real background sort doesn't
    reliably reach ``completed`` under TestClient (bare ``create_task`` tasks
    get cancelled when the portal tears down), and the point here is the report
    endpoint's contract, not the sort itself.
    """
    manager = client.app.state.container.task_manager
    done = Task(id="report-completed", coroutine_name="run")
    done.status = "completed"
    done.result = {"files_sorted": 3, "operation_id": "op-123"}
    manager._tasks[done.id] = done

    resp = client.get(f"/api/sorting/{done.id}/report")
    assert resp.status_code == 200
    assert resp.json() == {"files_sorted": 3, "operation_id": "op-123"}


def test_get_sorting_report_conflicts_when_not_completed(client: TestClient) -> None:
    """A still-running (or cancelled/failed) task has no report yet → 409, so the
    client can tell "not ready" apart from a genuinely empty completed report."""
    manager = client.app.state.container.task_manager
    running = Task(id="report-running", coroutine_name="run")
    running.status = "running"
    manager._tasks[running.id] = running

    resp = client.get(f"/api/sorting/{running.id}/report")
    assert resp.status_code == 409
    assert resp.json()["code"] == "CONFLICT"
