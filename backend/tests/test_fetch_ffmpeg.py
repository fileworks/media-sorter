from __future__ import annotations

import json
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
