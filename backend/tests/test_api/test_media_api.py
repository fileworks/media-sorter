"""Integration tests for the media (thumbnail) API route."""

import io
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client(tmp_path_factory) -> TestClient:
    base = tmp_path_factory.mktemp("media")
    config = Config(source_directory=str(base), target_directory=str(base / "dest"))
    app = AppFactory.create(config=config)
    return TestClient(app)


def _write_jpeg(path) -> None:
    Image.new("RGB", (320, 240), (200, 120, 40)).save(path, format="JPEG")


def test_thumbnail_returns_downscaled_jpeg(client: TestClient, tmp_path) -> None:
    img = tmp_path / "photo.jpg"
    _write_jpeg(img)
    response = client.get("/api/thumbnail", params={"path": str(img)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    # Body is a valid JPEG downscaled to the longest-edge cap.
    out = Image.open(io.BytesIO(response.content))
    assert max(out.size) <= 160


def test_thumbnail_missing_file_returns_415(client: TestClient, tmp_path) -> None:
    response = client.get("/api/thumbnail", params={"path": str(tmp_path / "nope.jpg")})
    assert response.status_code == 415


def test_thumbnail_non_image_returns_415(client: TestClient, tmp_path) -> None:
    vid = tmp_path / "clip.mp4"
    vid.write_bytes(b"\x00" * 256)
    response = client.get("/api/thumbnail", params={"path": str(vid)})
    assert response.status_code == 415


def test_thumbnail_requires_path(client: TestClient) -> None:
    response = client.get("/api/thumbnail")
    assert response.status_code == 422


def test_thumbnail_second_pass_uses_cache_and_conditional_etag(
    client: TestClient, tmp_path
) -> None:
    img = tmp_path / "cached.jpg"
    _write_jpeg(img)
    from app.api.routes import media

    with patch.object(media, "_render_thumbnail", wraps=media._render_thumbnail) as render:
        first = client.get("/api/thumbnail", params={"path": str(img), "size": 240})
        second = client.get("/api/thumbnail", params={"path": str(img), "size": 240})
        not_modified = client.get(
            "/api/thumbnail",
            params={"path": str(img), "size": 240},
            headers={"If-None-Match": first.headers["etag"]},
        )

    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert render.call_count == 1
    assert not_modified.status_code == 304
    assert not not_modified.content


def test_thumbnail_changed_source_changes_validator(client: TestClient, tmp_path) -> None:
    img = tmp_path / "changed.jpg"
    _write_jpeg(img)
    first = client.get("/api/thumbnail", params={"path": str(img)})
    Image.new("RGB", (320, 240), (10, 220, 40)).save(img, format="JPEG")

    second = client.get(
        "/api/thumbnail",
        params={"path": str(img)},
        headers={"If-None-Match": first.headers["etag"]},
    )

    assert second.status_code == 200
    assert second.headers["etag"] != first.headers["etag"]


def test_thumbnail_network_disconnect_degrades_to_placeholder(client: TestClient, tmp_path) -> None:
    image = tmp_path / "mounted-share.jpg"
    _write_jpeg(image)
    from app.api.routes import media

    with patch.object(
        media,
        "_render_thumbnail",
        side_effect=OSError("network volume disconnected during read"),
    ):
        response = client.get("/api/thumbnail", params={"path": str(image)})

    assert response.status_code == 415
    assert "network volume" not in response.text


# ── /api/media/info ────────────────────────────────────────────────────────────


def test_media_info_reports_resolution_and_size(client: TestClient, tmp_path) -> None:
    img = tmp_path / "photo.jpg"
    Image.new("RGB", (640, 480), (10, 20, 30)).save(img, format="JPEG")
    response = client.get("/api/media/info", params={"path": str(img)})
    assert response.status_code == 200
    body = response.json()
    assert body["width"] == 640
    assert body["height"] == 480
    assert body["media_type"] == "image"
    assert body["file_size"] > 0


def test_media_info_missing_file_is_all_null(client: TestClient, tmp_path) -> None:
    response = client.get("/api/media/info", params={"path": str(tmp_path / "gone.jpg")})
    assert response.status_code == 200
    body = response.json()
    assert body["width"] is None and body["height"] is None
    assert body["file_size"] is None
    assert body["media_type"] == "other"


def test_media_info_requires_path(client: TestClient) -> None:
    assert client.get("/api/media/info").status_code == 422


# ── /api/media/diff ────────────────────────────────────────────────────────────


def test_media_diff_returns_png(client: TestClient, tmp_path) -> None:
    a = tmp_path / "a.jpg"
    b = tmp_path / "b.jpg"
    Image.new("RGB", (64, 64), (0, 0, 0)).save(a, format="JPEG")
    img_b = Image.new("RGB", (64, 64), (0, 0, 0))
    for x in range(20):
        for y in range(20):
            img_b.putpixel((x, y), (255, 255, 255))  # a clear differing region
    img_b.save(b, format="JPEG")

    response = client.get("/api/media/diff", params={"a": str(a), "b": str(b)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    out = Image.open(io.BytesIO(response.content))
    assert out.format == "PNG"


def test_media_diff_non_image_returns_415(client: TestClient, tmp_path) -> None:
    a = tmp_path / "a.jpg"
    _write_jpeg(a)
    vid = tmp_path / "clip.mp4"
    vid.write_bytes(b"\x00" * 64)
    response = client.get("/api/media/diff", params={"a": str(a), "b": str(vid)})
    assert response.status_code == 415


def test_media_diff_requires_both_paths(client: TestClient, tmp_path) -> None:
    a = tmp_path / "a.jpg"
    _write_jpeg(a)
    assert client.get("/api/media/diff", params={"a": str(a)}).status_code == 422
