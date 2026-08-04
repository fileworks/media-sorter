"""Integration tests for the sorting API routes."""

from __future__ import annotations

import time
from pathlib import Path
from typing import cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.background_tasks.task_manager import Task
from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint


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


def test_changed_config_invalidates_reviewed_preview(client: TestClient) -> None:
    container = client.app.state.container  # type: ignore[attr-defined]
    original_sort = container.config.sort
    reviewed_fingerprint = config_fingerprint(container.config)
    try:
        changed = client.post("/api/config", json={"sort": not original_sort})
        assert changed.status_code == 200
        response = client.post(
            "/api/sorting/start",
            json={
                "dry_run": True,
                "expected_config_fingerprint": reviewed_fingerprint,
            },
        )
        assert response.status_code == 409
        assert response.json()["details"]["reason"] == "stale_preview"
    finally:
        client.post("/api/config", json={"sort": original_sort})


def test_sort_accepts_the_exact_plan_id_returned_by_preview(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    Image.new("RGB", (16, 16), "navy").save(source / "2024-01-02-photo.jpg")
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
        )
    )
    with TestClient(app) as local:
        preview = local.post("/api/preview").json()
        missing = local.post(
            "/api/sorting/start",
            json={"dry_run": False, "plan_id": "sortplan_missing"},
        )
        accepted = local.post(
            "/api/sorting/start",
            json={
                "dry_run": False,
                "expected_config_fingerprint": preview["config_fingerprint"],
                "plan_id": preview["plan_id"],
            },
        )
        task_id = accepted.json()["task_id"]
        status = local.get(f"/api/sorting/{task_id}").json()
        deadline = time.time() + 10
        while time.time() < deadline and status["status"] in {"pending", "running"}:
            time.sleep(0.05)
            status = local.get(f"/api/sorting/{task_id}").json()

    assert accepted.status_code == 200
    assert missing.status_code == 409
    assert missing.json()["details"]["reason"] == "missing_plan"
    assert status["status"] == "completed"
    assert Path(preview["items"][0]["destination"]).is_file()


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
    manager = cast("FastAPI", client.app).state.container.task_manager
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
    manager = cast("FastAPI", client.app).state.container.task_manager
    running = Task(id="report-running", coroutine_name="run")
    running.status = "running"
    manager._tasks[running.id] = running

    resp = client.get(f"/api/sorting/{running.id}/report")
    assert resp.status_code == 409
    assert resp.json()["code"] == "CONFLICT"


# ------------------------------------------------------------------ #
# POST /api/sorting/impact                                             #
# ------------------------------------------------------------------ #


def test_impact_describes_the_run_the_exclusions_leave(tmp_path: Path) -> None:
    """Execute asks the plan what it will do, rather than deriving it.

    Subtracting a per-reviewed-file tally from action-level totals counted two
    different things, so an exclusion that took a whole media unit off the plan
    left the preflight still promising part of it.
    """
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    # Distinct colours: two identical images would be a duplicate, not a
    # second sortable file.
    for name, colour in (("2024-01-02-one.jpg", "navy"), ("2024-01-03-two.jpg", "olive")):
        Image.new("RGB", (16, 16), colour).save(source / name)
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
        )
    )
    with TestClient(app) as local:
        preview = local.post("/api/preview").json()
        plan_id = preview["plan_id"]
        sortable = [item["source"] for item in preview["items"] if item["status"] == "sort"]

        whole = local.post("/api/sorting/impact", json={"plan_id": plan_id, "excluded_sources": []})
        one_off = local.post(
            "/api/sorting/impact",
            json={"plan_id": plan_id, "excluded_sources": sortable[:1]},
        )
        everything = local.post(
            "/api/sorting/impact",
            json={"plan_id": plan_id, "excluded_sources": sortable},
        )
        missing = local.post(
            "/api/sorting/impact", json={"plan_id": "sortplan_missing", "excluded_sources": []}
        )

    assert whole.status_code == 200
    assert whole.json()["actionable_groups"] == len(sortable)
    assert one_off.json()["actionable_groups"] == len(sortable) - 1
    assert one_off.json()["required_bytes"] < whole.json()["required_bytes"]
    assert everything.json()["actionable_groups"] == 0
    assert everything.json()["required_bytes"] == 0
    assert missing.status_code == 409
    assert missing.json()["details"]["reason"] == "missing_plan"


def test_impact_never_mutates_the_stored_plan(tmp_path: Path) -> None:
    """Asking what an exclusion would cost must not apply it."""
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    Image.new("RGB", (16, 16), "navy").save(source / "2024-01-02-photo.jpg")
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
        )
    )
    with TestClient(app) as local:
        preview = local.post("/api/preview").json()
        plan_id = preview["plan_id"]
        sortable = [item["source"] for item in preview["items"] if item["status"] == "sort"]

        local.post("/api/sorting/impact", json={"plan_id": plan_id, "excluded_sources": sortable})
        after = local.post("/api/sorting/impact", json={"plan_id": plan_id, "excluded_sources": []})

    assert after.json()["actionable_groups"] == len(sortable)
