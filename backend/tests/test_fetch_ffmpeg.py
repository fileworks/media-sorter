from __future__ import annotations

import email.message
import hashlib
import io
import json
import urllib.error
from pathlib import Path

import pytest
from scripts import fetch_ffmpeg

REPO_ROOT = Path(__file__).resolve().parents[2]


def _manifest(tmp_path: Path, sources: list[dict[str, object]]) -> Path:
    path = tmp_path / "sources.json"
    path.write_text(
        json.dumps({"manifest_version": "test", "targets": {"darwin-arm64": sources}}),
        encoding="utf-8",
    )
    return path


def test_binary_sources_are_materialized_without_archive_extraction(tmp_path: Path) -> None:
    downloaded = tmp_path / "downloaded"
    downloaded.write_bytes(b"executable")

    files = fetch_ffmpeg.materialize_source(
        {"format": "binary", "binaries": ["ffmpeg"]},
        downloaded,
        tmp_path / "unused",
    )

    assert files == [("ffmpeg", downloaded)]


def test_binary_source_must_declare_exactly_one_executable(tmp_path: Path) -> None:
    manifest = _manifest(
        tmp_path,
        [
            {
                "format": "binary",
                "binaries": ["ffmpeg", "ffprobe"],
                "license": "GPL-3.0-or-later",
                "sha256": "a" * 64,
                "upstream_version": "7.1",
                "url": "https://example.test/releases/v1/media-tools",
            }
        ],
    )

    with pytest.raises(SystemExit, match="must provide exactly one executable"):
        fetch_ffmpeg.load_sources("darwin", "arm64", manifest_path=manifest)


def test_apple_silicon_sources_are_immutable_github_assets() -> None:
    _, sources = fetch_ffmpeg.load_sources("darwin", "arm64")

    assert {source["format"] for source in sources} == {"binary"}
    assert {source["upstream_version"] for source in sources} == {"7.1"}
    assert all(
        source["url"].startswith(
            "https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/download/b7.1.0-rc.1/"
        )
        for source in sources
    )


def test_macos_minimum_matches_the_bundled_media_tools() -> None:
    config = json.loads(
        (REPO_ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )

    assert config["bundle"]["macOS"]["minimumSystemVersion"] == "12.0"


SOURCE_URL = "https://downloads.example/ffprobe.zip"


SOURCE_URL = "https://downloads.example/ffprobe.zip"


def _rate_limited(url: str, retry_after: str | None) -> Exception:
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError(url, 429, "Too Many Requests", headers, None)


def test_download_waits_for_retry_after_then_caches_the_verified_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"ffprobe archive"
    digest = hashlib.sha256(payload).hexdigest()
    responses: list[object] = [_rate_limited(SOURCE_URL, "40"), _rate_limited(SOURCE_URL, None)]

    def urlopen(request: object, timeout: int) -> io.BytesIO:
        if responses:
            raise responses.pop(0)  # type: ignore[misc]
        return io.BytesIO(payload)

    cache = tmp_path / "cache"
    monkeypatch.setenv(fetch_ffmpeg.CACHE_ENV, str(cache))
    monkeypatch.setattr(fetch_ffmpeg.urllib.request, "urlopen", urlopen)
    delays: list[float] = []

    fetch_ffmpeg.download(SOURCE_URL, digest, tmp_path / "first", sleep=delays.append)

    assert delays == [40.0, 30.0]
    assert (cache / digest).read_bytes() == payload

    def offline(request: object, timeout: int) -> io.BytesIO:
        raise AssertionError("a verified cache hit must not download")

    monkeypatch.setattr(fetch_ffmpeg.urllib.request, "urlopen", offline)
    fetch_ffmpeg.download(SOURCE_URL, digest, tmp_path / "second", sleep=delays.append)
    assert (tmp_path / "second").read_bytes() == payload


def test_a_cached_source_with_the_wrong_digest_is_downloaded_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"real bytes"
    digest = hashlib.sha256(payload).hexdigest()
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / digest).write_bytes(b"tampered")
    monkeypatch.setenv(fetch_ffmpeg.CACHE_ENV, str(cache))
    monkeypatch.setattr(
        fetch_ffmpeg.urllib.request, "urlopen", lambda request, timeout: io.BytesIO(payload)
    )

    fetch_ffmpeg.download(SOURCE_URL, digest, tmp_path / "out", sleep=lambda delay: None)

    assert (tmp_path / "out").read_bytes() == payload
    assert (cache / digest).read_bytes() == payload
