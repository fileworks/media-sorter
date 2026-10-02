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
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.plan_store import PlanExpiredError, UnsupportedPlanStoreVersionError


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


def test_a_live_start_without_a_reviewed_plan_is_refused(client: TestClient) -> None:
    """C-03. These two tests used to assert the defect.

    `dry_run: False` with no `plan_id` returned 200 and began mutating the
    filesystem with `frozen_plan=None` — no plan guard, no authorised effects,
    and nothing recording what the user had agreed to. "Reviewed" was a property
    the product hoped for rather than one it enforced.
    """
    response = client.post("/api/sorting/start", json={"dry_run": False})

    assert response.status_code == 409
    assert response.json()["details"]["reason"] == "plan_required"


def test_the_default_start_is_live_and_therefore_also_refused(client: TestClient) -> None:
    """The default has no `dry_run`, so it is a live run and needs a plan."""
    response = client.post("/api/sorting/start", json={})

    assert response.status_code == 409
    assert response.json()["details"]["reason"] == "plan_required"


def test_a_dry_run_still_needs_no_plan(client: TestClient) -> None:
    """A preview mutates nothing, so requiring a plan for it would be circular."""
    response = client.post("/api/sorting/start", json={"dry_run": True})

    assert response.status_code == 200
    assert "task_id" in response.json()


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
    config = Config(
        source_directory=str(source),
        target_directory=str(destination),
        copy_instead_of_move=True,
    )
    app = AppFactory.create(config=config)
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


def test_review_snapshot_and_decisions_recover_after_backend_restart(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    Image.new("RGB", (16, 16), "navy").save(source / "2024-01-02-photo.jpg")
    config = Config(
        source_directory=str(source),
        target_directory=str(destination),
        copy_instead_of_move=True,
    )
    app = AppFactory.create(config=config)

    with TestClient(app) as local:
        preview_response = local.post("/api/preview")
        assert preview_response.status_code == 200
        preview = preview_response.json()
        review_state = {
            "schema_version": 1,
            "config_fingerprint": preview["config_fingerprint"],
            "decisions": [],
            "selected_set_ids": [],
            "mode": "resolve",
            "queue_set_id": None,
            "detail_path": None,
            "viewer_path": None,
            "search": "",
            "tree_path": None,
            "view": "grid",
            "sort": "date",
            "keep_policy": "smart",
        }
        saved = local.put(
            f"/api/sorting/plans/{preview['plan_id']}/review-state",
            json=review_state,
        )
        assert saved.status_code == 200

    # A new app/container has no in-memory plan. Recovery must come entirely
    # from the durable envelope through the public HTTP contract.
    with TestClient(AppFactory.create(config=config)) as restarted:
        recovered = restarted.get(f"/api/sorting/plans/{preview['plan_id']}/recovery")

    assert recovered.status_code == 200
    assert recovered.json()["preview_result"] == preview
    assert recovered.json()["review_state"] == review_state


def test_review_state_rejects_ambiguous_duplicate_decisions(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    Image.new("RGB", (8, 8), "navy").save(source / "2024-01-02-photo.jpg")
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
        )
    )

    with TestClient(app) as local:
        preview = local.post("/api/preview").json()
        response = local.put(
            f"/api/sorting/plans/{preview['plan_id']}/review-state",
            json={
                "schema_version": 1,
                "config_fingerprint": preview["config_fingerprint"],
                "decisions": [
                    {"group_id": "set-1", "kind": "keeper", "member_id": "member-1"},
                    {"group_id": "set-1", "kind": "keep_all", "member_id": None},
                ],
                "selected_set_ids": [],
                "mode": "resolve",
                "queue_set_id": None,
                "detail_path": None,
                "viewer_path": None,
                "search": "",
                "tree_path": None,
                "view": "list",
                "sort": "name",
                "keep_policy": "smart",
            },
        )

    assert response.status_code == 422


def test_review_state_bounds_every_selected_set_identity(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    Image.new("RGB", (8, 8), "navy").save(source / "2024-01-02-photo.jpg")
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
        )
    )

    with TestClient(app) as local:
        preview = local.post("/api/preview").json()
        response = local.put(
            f"/api/sorting/plans/{preview['plan_id']}/review-state",
            json={
                "schema_version": 1,
                "config_fingerprint": preview["config_fingerprint"],
                "decisions": [],
                "selected_set_ids": ["x" * 513],
                "mode": "resolve",
                "queue_set_id": None,
                "detail_path": None,
                "viewer_path": None,
                "search": "",
                "tree_path": None,
                "view": "list",
                "sort": "name",
                "keep_policy": "smart",
            },
        )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (PlanExpiredError("expired"), "expired_plan"),
        (UnsupportedPlanStoreVersionError("newer"), "unsupported_plan"),
    ],
)
def test_recovery_returns_typed_conflicts_for_durable_store_refusals(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    failure: Exception,
    reason: str,
) -> None:
    service = client.app.state.container.preview_service  # type: ignore[attr-defined]

    def refuse(_plan_id: str) -> None:
        raise failure

    monkeypatch.setattr(service, "stored_plan", refuse)
    response = client.get("/api/sorting/plans/sortplan_refused/recovery")

    assert response.status_code == 409
    assert response.json()["details"]["reason"] == reason


def test_not_duplicates_survives_the_start_wire_and_real_sort(tmp_path: Path) -> None:
    """``keep_all`` restores both placements and bypasses run-local matching.

    This deliberately crosses every boundary the UI relies on: JSON request
    validation, the derived frozen plan, task dispatch, and the actual duplicate
    registry used by the running sorter. A model-only test would miss a route
    silently dropping the flag or a run collapsing the pair again.
    """
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    first = source / "2024-01-02-a.jpg"
    second = source / "2024-01-02-b.jpg"
    Image.new("RGB", (16, 16), "navy").save(first)
    second.write_bytes(first.read_bytes())
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
            remove_duplicates=True,
            duplicate_exact_enabled=True,
        )
    )

    with TestClient(app) as local:
        preview_response = local.post("/api/preview")
        assert preview_response.status_code == 200
        preview = preview_response.json()
        members = [item["source"] for item in preview["items"]]
        assert set(members) == {str(first), str(second)}
        assert sum(item["status"] == "duplicate" for item in preview["items"]) == 1
        decision = {"keep": members[0], "demote": [members[1]], "keep_all": True}

        impact = local.post(
            "/api/sorting/impact",
            json={"plan_id": preview["plan_id"], "reviewed_sets": [decision]},
        )
        started = local.post(
            "/api/sorting/start",
            json={
                "expected_config_fingerprint": preview["config_fingerprint"],
                "plan_id": preview["plan_id"],
                "reviewed_sets": [decision],
            },
        )
        assert started.status_code == 200
        task_id = started.json()["task_id"]
        status = local.get(f"/api/sorting/{task_id}").json()
        deadline = time.time() + 10
        while time.time() < deadline and status["status"] in {"pending", "running"}:
            time.sleep(0.05)
            status = local.get(f"/api/sorting/{task_id}").json()

    assert impact.status_code == 200
    assert impact.json()["copy_count"] == 2
    assert impact.json()["quarantine_count"] == 0
    assert status["status"] == "completed"
    assert status["result"]["sorted"] == 2
    assert status["result"]["duplicates"] == 0
    placed = list(destination.rglob("*.jpg"))
    assert {path.name for path in placed} == {first.name, second.name}
    assert all("_copies" not in path.parts for path in placed)


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


def test_impact_describes_the_directory_scoped_preview(tmp_path: Path) -> None:
    """The plan and preflight use the exact same configured-root scope."""
    source = tmp_path / "phone"
    skipped = tmp_path / "camera"
    destination = tmp_path / "destination"
    source.mkdir()
    skipped.mkdir()
    destination.mkdir()
    Image.new("RGB", (16, 16), "navy").save(source / "2024-01-02-phone.jpg")
    Image.new("RGB", (16, 16), "olive").save(skipped / "2024-01-03-camera.jpg")
    profile = LibraryProfile(
        profile_id="scope-test",
        name="Scope test",
        transfer_mode="copy",
        roots=[
            LibraryRoot(root_id="phone", role="input", path=str(source)),
            LibraryRoot(root_id="camera", role="input", path=str(skipped)),
            LibraryRoot(root_id="destination", role="destination", path=str(destination)),
        ],
    )
    app = AppFactory.create(
        config=Config(
            source_directory=str(source),
            target_directory=str(destination),
            copy_instead_of_move=True,
            library_profile=profile,
        )
    )
    with TestClient(app) as local:
        preview = local.post("/api/preview", json={"excluded_roots": ["camera"]}).json()
        plan_id = preview["plan_id"]
        scoped = local.post(
            "/api/sorting/impact",
            json={"plan_id": plan_id, "excluded_roots": ["camera"]},
        )
        changed_scope = local.post("/api/sorting/impact", json={"plan_id": plan_id})
        missing = local.post(
            "/api/sorting/impact",
            json={"plan_id": "sortplan_missing", "excluded_roots": ["camera"]},
        )
        started = local.post(
            "/api/sorting/start",
            json={
                "expected_config_fingerprint": preview["config_fingerprint"],
                "plan_id": plan_id,
                "excluded_roots": ["camera"],
            },
        )
        task_id = started.json()["task_id"]
        status = local.get(f"/api/sorting/{task_id}").json()
        deadline = time.time() + 10
        while time.time() < deadline and status["status"] in {"pending", "running"}:
            time.sleep(0.05)
            status = local.get(f"/api/sorting/{task_id}").json()
        operation_id = status["result"]["operation_id"]
        report = local.get(f"/api/reports/{operation_id}")

    assert preview["excluded_roots"] == [str(skipped)]
    assert preview["excluded_root_ids"] == ["camera"]
    assert {item["source"] for item in preview["items"]} == {str(source / "2024-01-02-phone.jpg")}
    assert scoped.status_code == 200
    assert scoped.json()["actionable_groups"] == 1
    assert changed_scope.status_code == 409
    assert changed_scope.json()["details"]["reason"] == "stale_plan_scope"
    assert missing.status_code == 409
    assert missing.json()["details"]["reason"] == "missing_plan"
    assert started.status_code == 200
    assert status["status"] == "completed"
    assert status["result"]["excluded_roots"] == [str(skipped)]
    assert report.status_code == 200
    assert report.json()["excluded_roots"] == [str(skipped)]
    assert not any(path.name == "2024-01-03-camera.jpg" for path in destination.rglob("*"))
