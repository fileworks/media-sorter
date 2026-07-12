"""Tests for the junk / thumbnail filter (P0-2)."""

from pathlib import Path

from PIL import Image

from app.core.config import Config
from app.services.junk_filter import classify_junk


def _config(**overrides: object) -> Config:
    base: dict = {"junk_filter_enabled": True}
    base.update(overrides)
    return Config(**base)


def _image(path: Path, width: int, height: int, quality: int = 90) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (width, height), color=(90, 120, 60)).save(path, quality=quality)
    return path


class TestDisabled:
    def test_disabled_never_classifies(self, tmp_path: Path) -> None:
        f = tmp_path / "Thumbs.db"
        f.write_bytes(b"x")
        assert classify_junk(f, Config()) is None  # off by default


class TestNamePatterns:
    def test_known_junk_filename(self, tmp_path: Path) -> None:
        f = tmp_path / "Thumbs.db"
        f.write_bytes(b"x" * 20_000)
        reason = classify_junk(f, _config())
        assert reason is not None and "pattern" in reason

    def test_thumb_suffix_pattern_case_insensitive(self, tmp_path: Path) -> None:
        f = _image(tmp_path / "IMG_1234-THUMB.JPG", 800, 600)
        assert classify_junk(f, _config(junk_min_file_size_kb=0)) is not None

    def test_thumbnail_directory(self, tmp_path: Path) -> None:
        f = _image(tmp_path / ".thumbnails" / "IMG_1234.jpg", 800, 600)
        reason = classify_junk(f, _config(junk_min_file_size_kb=0))
        assert reason is not None and "directory" in reason

    def test_normal_photo_not_matched(self, tmp_path: Path) -> None:
        f = _image(tmp_path / "IMG_1234.jpg", 800, 600)
        assert classify_junk(f, _config(junk_min_file_size_kb=0)) is None


class TestSizeFloor:
    def test_below_floor(self, tmp_path: Path) -> None:
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"x" * 512)  # 0.5 KB
        reason = classify_junk(f, _config(junk_min_file_size_kb=8))
        assert reason is not None and "size" in reason

    def test_at_or_above_floor(self, tmp_path: Path) -> None:
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"x" * 8 * 1024)
        assert classify_junk(f, _config(junk_min_file_size_kb=8)) is None

    def test_zero_disables_floor(self, tmp_path: Path) -> None:
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"x")
        assert classify_junk(f, _config(junk_min_file_size_kb=0)) is None


class TestResolutionFloor:
    def test_tiny_image_below_floor(self, tmp_path: Path) -> None:
        f = _image(tmp_path / "preview.jpg", 160, 120)
        reason = classify_junk(f, _config(junk_min_file_size_kb=0))
        assert reason is not None and "resolution" in reason

    def test_shorter_side_rule(self, tmp_path: Path) -> None:
        # 1000x150: long side is fine, shorter side is under the 200px floor.
        f = _image(tmp_path / "pano-strip.jpg", 1000, 150)
        assert classify_junk(f, _config(junk_min_file_size_kb=0)) is not None

    def test_regular_photo_passes(self, tmp_path: Path) -> None:
        f = _image(tmp_path / "photo.jpg", 640, 480)
        assert classify_junk(f, _config(junk_min_file_size_kb=0)) is None

    def test_unreadable_dimensions_are_not_junk(self, tmp_path: Path) -> None:
        f = tmp_path / "broken.jpg"
        f.write_bytes(b"not an image" * 4096)  # big enough to pass the size floor
        assert classify_junk(f, _config()) is None

    def test_non_image_skips_resolution_check(self, tmp_path: Path) -> None:
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"x" * 20_000)
        assert classify_junk(f, _config()) is None
