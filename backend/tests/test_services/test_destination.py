"""Tests for the shared destination builder — the sort/preview agreement contract."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from app.core.config import Config
from app.services.destination import build_dest_dir, predicted_filename, rename_stem


def _cfg(**overrides: object) -> Config:
    defaults: dict = {
        "source_directory": "/src",
        "target_directory": "/dst",
        "sort_criteria": ["year", "month", "day"],
    }
    defaults.update(overrides)
    return Config(**defaults)


def test_build_dest_dir_is_pure(tmp_path: Path) -> None:
    """Computing a destination never creates directories."""
    dest_root = tmp_path / "out"
    d = build_dest_dir(Path("/src/a/photo.jpg"), date(2024, 3, 10), Path("/src"), dest_root, _cfg())
    assert d == dest_root / "2024" / "03" / "10"
    assert not dest_root.exists()


def test_build_dest_dir_category_wins_over_subfolders() -> None:
    cfg = _cfg(categorize_enabled=True, preserve_subfolders=True)
    d = build_dest_dir(
        Path("/src/sub/photo.jpg"), date(2024, 1, 2), Path("/src"), Path("/dst"), cfg, "pets"
    )
    assert d == Path("/dst/2024/01/02/pets")


def test_build_dest_dir_preserves_subfolders_and_stacks_camera() -> None:
    cfg = _cfg(preserve_subfolders=True, camera_subfolder_enabled=True)
    d = build_dest_dir(
        Path("/src/holiday/photo.jpg"),
        date(2024, 1, 2),
        Path("/src"),
        Path("/dst"),
        cfg,
        None,
        "iPhone-15",
    )
    assert d == Path("/dst/2024/01/02/holiday/iPhone-15")


def test_rename_stem_substitutes_all_tokens() -> None:
    out = rename_stem("YYYY-MM-DD_TYPE_NAME", date(2023, 5, 7), "orig", "IMG")
    assert out == "2023-05-07_IMG_orig"


def test_rename_stem_single_pass_no_double_substitution() -> None:
    """A NAME containing 'MM' must not get date-substituted afterwards."""
    out = rename_stem("NAME", date(2023, 5, 7), "SUMMER", "IMG")
    assert out == "SUMMER"


def test_predicted_filename_reflects_rename_and_conversion() -> None:
    cfg = _cfg(rename=True, rename_pattern="YYYY_NAME", convert_images=True, image_format="jpeg")
    name = predicted_filename(Path("/src/photo.png"), date(2022, 8, 1), cfg)
    assert name == "2022_photo.jpg"


def test_predicted_filename_conversion_noop_for_target_format() -> None:
    cfg = _cfg(convert_images=True, image_format="jpeg")
    assert predicted_filename(Path("/src/photo.JPG"), date(2022, 8, 1), cfg) == "photo.JPG"


def test_predicted_filename_video_conversion() -> None:
    cfg = _cfg(convert_videos=True, video_format="mp4")
    assert predicted_filename(Path("/src/clip.mov"), date(2022, 8, 1), cfg) == "clip.mp4"
    assert predicted_filename(Path("/src/clip.mp4"), date(2022, 8, 1), cfg) == "clip.mp4"
