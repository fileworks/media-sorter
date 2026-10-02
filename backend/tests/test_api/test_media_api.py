"""Integration tests for the media (thumbnail) API route."""

import asyncio
import io
import mimetypes
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import media
from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.media_scope import assert_media_readable


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    # Every per-test `tmp_path` lives under this base, so the files these tests
    # create are inside the configured library. The media routes require that
    # now: a path outside every configured root is refused before it is opened.
    base = tmp_path_factory.getbasetemp()
    config = Config(source_directory=str(base), target_directory=str(base / "dest"))
    app = AppFactory.create(config=config)
    return TestClient(app)


@pytest.fixture
def outside_library() -> Iterator[Path]:
    """A real directory that is deliberately not under any configured root."""
    location = Path(tempfile.mkdtemp(prefix="outside-library-"))
    try:
        yield location
    finally:
        shutil.rmtree(location, ignore_errors=True)


def _write_jpeg(path: Any) -> None:
    Image.new("RGB", (320, 240), (200, 120, 40)).save(path, format="JPEG")


@pytest.mark.parametrize("endpoint", ["thumbnail", "media/info", "media/content", "media/diff"])
def test_media_path_resolution_runs_off_the_event_loop(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    source = tmp_path / "threaded.jpg"
    _write_jpeg(source)
    checked: list[str] = []

    def require_worker(raw_path: str, config: Config) -> Path:
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        checked.append(raw_path)
        return assert_media_readable(raw_path, config)

    monkeypatch.setattr(media, "assert_media_readable", require_worker)
    params = (
        {"a": str(source), "b": str(source)} if endpoint == "media/diff" else {"path": str(source)}
    )
    response = client.get(f"/api/{endpoint}", params=params)
    assert response.status_code == (415 if endpoint == "media/content" else 200)
    assert checked == [str(source)] * (2 if endpoint == "media/diff" else 1)


def test_thumbnail_bounds_decode_before_rgb_conversion_and_keeps_orientation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "portrait.jpg"
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (2400, 1600), "red").save(source, exif=exif)
    source_bytes = source.read_bytes()
    original = Image.Image.convert
    converted_sizes: list[tuple[int, int]] = []

    def bounded_convert(image: Image.Image, *args: Any, **kwargs: Any) -> Image.Image:
        converted_sizes.append(image.size)
        return original(image, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "convert", bounded_convert)
    data = media._render_thumbnail(str(source), 240)
    assert data is not None
    with Image.open(io.BytesIO(data)) as thumbnail:
        assert thumbnail.size == (160, 240)
    assert converted_sizes and all(max(size) <= 240 for size in converted_sizes)
    assert source.read_bytes() == source_bytes


def test_cold_video_mime_lookup_runs_off_the_event_loop(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "video.mp4"
    source.write_bytes(b"disposable video response fixture")
    original = mimetypes.init
    calls: list[bool] = []

    def require_worker() -> None:
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        calls.append(True)
        original()

    monkeypatch.setattr(mimetypes, "inited", False)
    monkeypatch.setattr(mimetypes, "init", require_worker)
    response = client.get("/api/media/content", params={"path": str(source)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    assert calls == [True]


def test_thumbnail_returns_downscaled_jpeg(client: TestClient, tmp_path: Path) -> None:
    img = tmp_path / "photo.jpg"
    _write_jpeg(img)
    response = client.get("/api/thumbnail", params={"path": str(img)})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    # Body is a valid JPEG downscaled to the longest-edge cap.
    out = Image.open(io.BytesIO(response.content))
    assert max(out.size) <= 160


def test_thumbnail_missing_file_returns_415(client: TestClient, tmp_path: Path) -> None:
    response = client.get("/api/thumbnail", params={"path": str(tmp_path / "nope.jpg")})
    assert response.status_code == 415


def test_thumbnail_non_image_returns_415(client: TestClient, tmp_path: Path) -> None:
    vid = tmp_path / "clip.mp4"
    vid.write_bytes(b"\x00" * 256)
    response = client.get("/api/thumbnail", params={"path": str(vid)})
    assert response.status_code == 415


def test_thumbnail_requires_path(client: TestClient) -> None:
    response = client.get("/api/thumbnail")
    assert response.status_code == 422


def test_thumbnail_second_pass_uses_cache_and_conditional_etag(
    client: TestClient, tmp_path: Path
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


def test_thumbnail_changed_source_changes_validator(client: TestClient, tmp_path: Path) -> None:
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


def test_thumbnail_network_disconnect_degrades_to_placeholder(
    client: TestClient, tmp_path: Path
) -> None:
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


def test_media_info_reports_resolution_and_size(client: TestClient, tmp_path: Path) -> None:
    img = tmp_path / "photo.jpg"
    Image.new("RGB", (640, 480), (10, 20, 30)).save(img, format="JPEG")
    response = client.get("/api/media/info", params={"path": str(img)})
    assert response.status_code == 200
    body = response.json()
    assert body["width"] == 640
    assert body["height"] == 480
    assert body["media_type"] == "image"
    assert body["file_size"] > 0


def test_media_info_missing_file_is_all_null(client: TestClient, tmp_path: Path) -> None:
    response = client.get("/api/media/info", params={"path": str(tmp_path / "gone.jpg")})
    assert response.status_code == 200
    body = response.json()
    assert body["width"] is None and body["height"] is None
    assert body["file_size"] is None
    assert body["media_type"] == "other"


def test_media_info_requires_path(client: TestClient) -> None:
    assert client.get("/api/media/info").status_code == 422


def test_media_info_keeps_unknown_video_facts_unknown(client: TestClient, tmp_path: Path) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not a decodable video")

    response = client.get("/api/media/info", params={"path": str(video)})

    assert response.status_code == 200
    body = response.json()
    assert body["media_type"] == "video"
    assert body["duration_seconds"] is None
    assert body["codec"] is None


def test_authenticated_video_content_returns_the_original_bytes(
    client: TestClient, tmp_path: Path
) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"synthetic-video-bytes")

    response = client.get("/api/media/content", params={"path": str(video)})

    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    assert response.content == video.read_bytes()


def test_video_content_rejects_non_video_files(client: TestClient, tmp_path: Path) -> None:
    image = tmp_path / "photo.jpg"
    _write_jpeg(image)

    assert client.get("/api/media/content", params={"path": str(image)}).status_code == 415


# ── /api/media/diff ────────────────────────────────────────────────────────────


def test_media_diff_returns_png(client: TestClient, tmp_path: Path) -> None:
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


def test_media_diff_non_image_returns_415(client: TestClient, tmp_path: Path) -> None:
    a = tmp_path / "a.jpg"
    _write_jpeg(a)
    vid = tmp_path / "clip.mp4"
    vid.write_bytes(b"\x00" * 64)
    response = client.get("/api/media/diff", params={"a": str(a), "b": str(vid)})
    assert response.status_code == 415


def test_media_diff_requires_both_paths(client: TestClient, tmp_path: Path) -> None:
    a = tmp_path / "a.jpg"
    _write_jpeg(a)
    assert client.get("/api/media/diff", params={"a": str(a)}).status_code == 422


# ------------------------------------------------------------------ #
# Library scope                                                        #
# ------------------------------------------------------------------ #
#
# Every path below arrives from the client. These routes used to open whatever
# they were given, on the reasoning that a loopback backend has no other
# origin. `app.core.api_security` exists because that is not true, so a read
# outside the configured library is refused rather than served.


def test_thumbnail_outside_the_library_is_refused(
    client: TestClient, outside_library: Path
) -> None:
    secret = outside_library / "private.jpg"
    _write_jpeg(secret)

    response = client.get("/api/thumbnail", params={"path": str(secret)})

    assert response.status_code == 403
    assert response.json()["code"] == "MEDIA_OUTSIDE_LIBRARY"


def test_video_content_outside_the_library_is_refused(
    client: TestClient, outside_library: Path
) -> None:
    secret = outside_library / "private.mp4"
    secret.write_bytes(b"\x00" * 256)

    response = client.get("/api/media/content", params={"path": str(secret)})

    assert response.status_code == 403
    assert response.json()["code"] == "MEDIA_OUTSIDE_LIBRARY"


def test_media_info_outside_the_library_is_refused(
    client: TestClient, outside_library: Path
) -> None:
    secret = outside_library / "private.jpg"
    _write_jpeg(secret)

    response = client.get("/api/media/info", params={"path": str(secret)})

    assert response.status_code == 403


def test_media_diff_refuses_when_either_side_is_outside(
    client: TestClient, tmp_path: Path, outside_library: Path
) -> None:
    inside = tmp_path / "inside.jpg"
    _write_jpeg(inside)
    secret = outside_library / "private.jpg"
    _write_jpeg(secret)

    assert (
        client.get("/api/media/diff", params={"a": str(inside), "b": str(secret)}).status_code
        == 403
    )
    assert (
        client.get("/api/media/diff", params={"a": str(secret), "b": str(inside)}).status_code
        == 403
    )


def test_a_symlink_inside_the_library_cannot_escape_it(
    client: TestClient, tmp_path: Path, outside_library: Path
) -> None:
    """The check resolves links; a textual prefix comparison would serve this."""
    secret = outside_library / "private.jpg"
    _write_jpeg(secret)
    bait = tmp_path / "holiday.jpg"
    bait.symlink_to(secret)

    # The bait's own path really is inside a configured root.
    assert str(bait).startswith(str(tmp_path))

    response = client.get("/api/thumbnail", params={"path": str(bait)})

    assert response.status_code == 403


def test_a_vanished_file_inside_the_library_still_degrades_normally(
    client: TestClient, tmp_path: Path
) -> None:
    """Media on a disconnected share disappears routinely; that is not a probe."""
    response = client.get("/api/media/info", params={"path": str(tmp_path / "gone.jpg")})

    assert response.status_code == 200
    assert response.json()["width"] is None


def test_a_nonexistent_path_outside_the_library_is_still_refused(
    client: TestClient, outside_library: Path
) -> None:
    """Otherwise a probe learns whether a path exists by which error it gets."""
    response = client.get("/api/media/info", params={"path": str(outside_library / "nope.jpg")})

    assert response.status_code == 403
