"""Integration tests for the preview API route."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = AppFactory.create(config=Config.defaults())
    return TestClient(app)


# ------------------------------------------------------------------ #
# POST /api/preview                                                      #
# ------------------------------------------------------------------ #


def test_preview_returns_200(client: TestClient, tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src"
    target = tmp_path / "dst"
    source.mkdir()
    target.mkdir()

    img = source / "photo.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 09:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    # Configure so the app knows about source/target
    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(target),
            "sort_criteria": ["year", "month", "day"],
        },
    )

    response = client.post("/api/preview")
    assert response.status_code == 200


def test_preview_response_structure(client: TestClient, tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src2"
    target = tmp_path / "dst2"
    source.mkdir()
    target.mkdir()

    img = source / "test.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2023:12:25 08:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    client.post(
        "/api/config",
        json={"source_directory": str(source), "target_directory": str(target)},
    )

    data = client.post("/api/preview").json()

    assert "items" in data
    assert "stats" in data
    assert "total" in data["stats"]
    assert "will_sort" in data["stats"]
    assert "will_fail" in data["stats"]


def test_preview_does_not_create_files(client: TestClient, tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src3"
    target = tmp_path / "dst3"
    source.mkdir()
    target.mkdir()

    img = source / "shot.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    client.post(
        "/api/config",
        json={"source_directory": str(source), "target_directory": str(target)},
    )
    client.post("/api/preview")

    assert list(target.rglob("*")) == []


def test_preview_item_contains_destination(client: TestClient, tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src4"
    target = tmp_path / "dst4"
    source.mkdir()
    target.mkdir()

    img = source / "pic.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:07:04 10:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(target),
            "sort_criteria": ["year", "month", "day"],
        },
    )
    data = client.post("/api/preview").json()

    assert len(data["items"]) == 1
    item = data["items"][0]
    assert "source" in item
    assert "destination" in item
    assert "2024" in item["destination"]


# ------------------------------------------------------------------ #
# POST /api/preview/start  +  GET /api/preview/{task_id}                #
# ------------------------------------------------------------------ #


def test_preview_start_returns_task_id(client: TestClient) -> None:
    response = client.post("/api/preview/start")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data.get("task_id"), str) and data["task_id"]


def test_preview_unknown_task_returns_error(client: TestClient) -> None:
    response = client.get("/api/preview/does-not-exist")
    assert response.status_code >= 400


def test_preview_task_completes_with_progress_and_result(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "psrc"
    target = tmp_path / "pdst"
    source.mkdir()
    target.mkdir()
    img = source / "photo.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 09:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    # A context-managed client keeps a single event loop alive across requests
    # so the background preview task actually runs to completion (the module
    # `client` fixture would tear the loop down after each request).
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as c:
        c.post(
            "/api/config",
            json={
                "source_directory": str(source),
                "target_directory": str(target),
                "sort_criteria": ["year", "month", "day"],
            },
        )

        task_id = c.post("/api/preview/start").json()["task_id"]

        deadline = time.time() + 10
        progress = c.get(f"/api/preview/{task_id}").json()
        while time.time() < deadline and progress["status"] in ("pending", "running"):
            time.sleep(0.1)
            progress = c.get(f"/api/preview/{task_id}").json()

    assert progress["status"] == "completed"
    assert progress["progress"]["total"] == 1
    assert progress["progress"]["current"] == 1
    assert progress["result"] is not None
    assert len(progress["result"]["items"]) == 1
    assert "2024" in progress["result"]["items"][0]["destination"]
    # Preview must never write to the destination.
    assert list(target.rglob("*")) == []
