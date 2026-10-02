"""Tests for app.utils.media_utils type-detection helpers."""

from pathlib import Path

from app.utils.media_utils import (
    IMAGE_EXTENSIONS,
    MEDIA_EXTENSIONS,
    VIDEO_EXTENSIONS,
    get_file_type,
    is_image,
    is_media,
    is_size_included,
    is_video,
)


def test_media_set_is_union_of_image_and_video() -> None:
    assert MEDIA_EXTENSIONS == IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
    # Images and videos are disjoint sets.
    assert not (IMAGE_EXTENSIONS & VIDEO_EXTENSIONS)


def test_is_image_recognises_images() -> None:
    assert is_image(Path("photo.jpg"))
    assert is_image(Path("scan.PNG"))  # case-insensitive
    assert is_image(Path("raw.nef"))
    assert not is_image(Path("clip.mp4"))
    assert not is_image(Path("notes.txt"))


def test_is_video_recognises_videos() -> None:
    assert is_video(Path("clip.mp4"))
    assert is_video(Path("movie.MOV"))  # case-insensitive
    assert not is_video(Path("photo.jpg"))
    assert not is_video(Path("notes.txt"))


def test_is_media_covers_both() -> None:
    assert is_media(Path("photo.jpg"))
    assert is_media(Path("clip.mp4"))
    assert not is_media(Path("notes.txt"))


def test_no_extension_is_not_media() -> None:
    assert not is_image(Path("README"))
    assert not is_video(Path("README"))
    assert not is_media(Path("README"))
    assert get_file_type(Path("README")) == "unknown"


def test_get_file_type() -> None:
    assert get_file_type(Path("photo.JPEG")) == "image"
    assert get_file_type(Path("clip.MKV")) == "video"
    assert get_file_type(Path("archive.zip")) == "unknown"


def test_helpers_accept_full_paths() -> None:
    assert is_image(Path("/a/b/c/photo.heic"))
    assert is_video(Path("/a/b/c/clip.webm"))


# ── is_size_included ──────────────────────────────────────────────────────────


def test_is_size_included_no_bounds() -> None:
    """When both bounds are None every size passes."""
    assert is_size_included(0, None, None)
    assert is_size_included(1, None, None)
    assert is_size_included(10 * 1024 * 1024 * 1024, None, None)


def test_is_size_included_below_min() -> None:
    assert not is_size_included(512, min_kb=1, max_mb=None)  # 512 B < 1 KB
    assert not is_size_included(1023, min_kb=1, max_mb=None)  # just under 1 KB


def test_is_size_included_at_min_boundary() -> None:
    assert is_size_included(1024, min_kb=1, max_mb=None)  # exactly 1 KB → included


def test_is_size_included_above_max() -> None:
    assert not is_size_included(1024 * 1024 * 1024 + 1, min_kb=None, max_mb=1024)
    assert not is_size_included(2 * 1024 * 1024 * 1024, min_kb=None, max_mb=1024)


def test_is_size_included_at_max_boundary() -> None:
    assert is_size_included(1024 * 1024 * 1024, min_kb=None, max_mb=1024)  # exactly 1 GB


def test_is_size_included_within_both_bounds() -> None:
    size = 5 * 1024 * 1024  # 5 MB
    assert is_size_included(size, min_kb=1, max_mb=100)


def test_is_size_included_zero_min_kb_honoured() -> None:
    """min_kb=0 must NOT be treated as falsy — 0 KB ≥ 0 KB, so everything passes."""
    assert is_size_included(0, min_kb=0, max_mb=None)
    assert is_size_included(1, min_kb=0, max_mb=None)
