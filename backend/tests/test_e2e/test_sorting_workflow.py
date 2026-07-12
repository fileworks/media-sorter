"""End-to-end tests for the full config → preview → sort → report workflow."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client():  # type: ignore[return]
    """Module-scoped TestClient used as context manager so the anyio portal (and its
    event loop) stays alive across requests, allowing asyncio background tasks to
    complete without being cancelled when the per-request portal closes."""
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as c:
        yield c


def _wait_for_completion(client: TestClient, task_id: str, timeout: float = 30.0) -> dict:
    """Poll /api/sorting/{task_id} until status is terminal; return final progress dict."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"/api/sorting/{task_id}")
        assert resp.status_code == 200
        data = resp.json()
        if data["status"] not in ("pending", "running"):
            return data
        time.sleep(0.2)
    pytest.fail(f"Task {task_id} did not complete within {timeout}s")


def _create_dated_images(source: Path, dates_and_files: list) -> None:
    """Create distinct JPEGs with the given EXIF dates in source."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    for idx, (exif_ts, name) in enumerate(dates_and_files):
        img = source / name
        # Use distinct colors so each image has a unique perceptual hash
        color = (idx * 60 % 256, (idx * 40 + 50) % 256, (idx * 80 + 100) % 256)
        PIL_Image.new("RGB", (100, 100), color=color).save(img, format="JPEG")
        exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: exif_ts}}
        piexif.insert(piexif.dump(exif_dict), str(img))


# ------------------------------------------------------------------ #
# Full workflow                                                           #
# ------------------------------------------------------------------ #


def test_full_sort_workflow_with_dated_images(tmp_path: Path, client: TestClient) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    dates_and_files = [
        (b"2024:01:15 10:00:00", "photo_001.jpg"),
        (b"2024:01:16 11:00:00", "photo_002.jpg"),
        (b"2024:02:20 12:00:00", "photo_003.jpg"),
        (b"2023:12:25 09:00:00", "photo_004.jpg"),
    ]
    _create_dated_images(source, dates_and_files)

    # 1. Configure
    cfg_resp = client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(target),
            "sort": True,
            "sort_criteria": ["year", "month", "day"],
            "copy_instead_of_move": True,
            "recursive_scan": True,
            "remove_duplicates": False,  # All images are unique; skip dup-check overhead
        },
    )
    assert cfg_resp.status_code == 200

    # 2. Preview (dry run)
    preview_resp = client.post("/api/preview")
    assert preview_resp.status_code == 200
    preview_data = preview_resp.json()
    assert preview_data["stats"]["total"] == 4
    assert preview_data["stats"]["will_sort"] == 4
    assert preview_data["stats"]["will_fail"] == 0
    # Source files must still be there after a dry-run preview
    assert (source / "photo_001.jpg").exists()

    # 3. Sort (dry_run=True — previews destinations, doesn't copy files)
    start_resp = client.post("/api/sorting/start", json={"dry_run": True})
    assert start_resp.status_code == 200
    task_id = start_resp.json()["task_id"]

    final = _wait_for_completion(client, task_id)
    assert final["status"] == "completed"

    # 4. Report
    report_resp = client.get(f"/api/sorting/{task_id}/report")
    assert report_resp.status_code == 200
    report = report_resp.json()
    assert report["total"] == 4
    assert report["sorted"] == 4
    assert report["failed"] == 0


def test_dry_run_does_not_copy_files(tmp_path: Path, client: TestClient) -> None:
    """Dry-run sort must not copy any actual files to the target."""
    source = tmp_path / "src_dry"
    target = tmp_path / "dst_dry"
    source.mkdir()
    target.mkdir()

    _create_dated_images(source, [(b"2024:05:01 00:00:00", "shot.jpg")])

    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(target),
            "copy_instead_of_move": False,  # would move in a real run
            "remove_duplicates": False,
        },
    )

    start_resp = client.post("/api/sorting/start", json={"dry_run": True})
    task_id = start_resp.json()["task_id"]
    final = _wait_for_completion(client, task_id)
    assert final["status"] == "completed"

    # Source file must still be present (dry-run never touches the source)
    assert (source / "shot.jpg").exists()
    # No actual files should have been copied to the target
    assert list(target.rglob("*.*")) == [], "Dry-run should not copy files to target"


def test_sort_workflow_with_copy_produces_correct_structure(
    tmp_path: Path, client: TestClient
) -> None:
    source = tmp_path / "src_copy"
    target = tmp_path / "dst_copy"
    source.mkdir()
    target.mkdir()

    dates_and_files = [
        (b"2024:01:15 10:00:00", "img_a.jpg"),
        (b"2024:02:20 12:00:00", "img_b.jpg"),
        (b"2023:12:25 09:00:00", "img_c.jpg"),
    ]
    _create_dated_images(source, dates_and_files)

    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(target),
            "sort_criteria": ["year", "month", "day"],
            "copy_instead_of_move": True,
            "remove_duplicates": False,
        },
    )

    start_resp = client.post("/api/sorting/start", json={"dry_run": False})
    task_id = start_resp.json()["task_id"]
    final = _wait_for_completion(client, task_id, timeout=30)
    assert final["status"] == "completed"

    # Verify the date-based directory structure was created
    expected_dirs = ["2024/01/15", "2024/02/20", "2023/12/25"]
    for expected_dir in expected_dirs:
        assert (target / expected_dir).is_dir(), f"Expected dir {expected_dir} not found"

    # Verify files were actually copied (copy_instead_of_move=True)
    assert (target / "2024/01/15/img_a.jpg").exists()
    assert (target / "2024/02/20/img_b.jpg").exists()
    assert (target / "2023/12/25/img_c.jpg").exists()
    # Source files should still be present (copy, not move)
    assert (source / "img_a.jpg").exists()


def test_sort_workflow_health_check(client: TestClient) -> None:
    """Sanity check: health endpoint is reachable throughout test session."""
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
