"""Integration tests for the analysis API routes."""

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client(tmp_path_factory) -> TestClient:
    base = tmp_path_factory.mktemp("analysis")
    src = base / "source"
    src.mkdir()
    dst = base / "dest"
    dst.mkdir()
    config = Config(source_directory=str(src), target_directory=str(dst))
    app = AppFactory.create(config=config)
    return TestClient(app)


def test_analysis_returns_200(client: TestClient) -> None:
    response = client.post("/api/analysis")
    assert response.status_code == 200
    data = response.json()
    assert "total_files" in data
    assert "by_type" in data
    assert "disk_space" in data
    assert "date_range" in data
    assert "excluded_files" in data
    assert "estimated_duration_seconds" in data


def test_analysis_returns_400_without_source(tmp_path) -> None:
    config = Config(source_directory="", target_directory=str(tmp_path))
    app = AppFactory.create(config=config)
    c = TestClient(app)
    response = c.post("/api/analysis")
    assert response.status_code == 400


def test_disk_space_returns_200(client: TestClient) -> None:
    response = client.get("/api/analysis/disk-space")
    assert response.status_code == 200
    data = response.json()
    assert "source_size_bytes" in data
    assert "destination_free_bytes" in data
    assert "sufficient" in data
    assert "mode" in data


def test_analysis_counts_files(tmp_path) -> None:
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\xff\xd8\xff" + b"\x00" * 1000)
    (src / "video.mp4").write_bytes(b"\x00" * 2000)
    config = Config(source_directory=str(src), target_directory=str(tmp_path / "dest"))
    app = AppFactory.create(config=config)
    c = TestClient(app)
    response = c.post("/api/analysis")
    assert response.status_code == 200
    data = response.json()
    assert data["total_files"] == 2
