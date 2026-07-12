"""Tests for ConversionService — image and video format conversion."""

from __future__ import annotations

import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.conversion_service import ConversionService


@pytest.fixture()
def svc() -> ConversionService:
    return ConversionService()


@pytest.fixture()
def jpeg_source(tmp_path: Path) -> Path:
    """Create a source JPEG with EXIF that can be converted."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "photo.jpg"
    PIL_Image.new("RGB", (80, 80), color=(200, 100, 50)).save(p, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:15 10:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(p))
    return p


@pytest.fixture()
def tiff_source(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "image.tif"
    PIL_Image.new("RGB", (60, 60), color=(10, 20, 30)).save(p, format="TIFF")
    return p


@pytest.fixture()
def png_source(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "image.png"
    PIL_Image.new("RGB", (100, 100), color=(64, 128, 200)).save(p, format="PNG")
    return p


@pytest.fixture()
def rgba_png(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "transparent.png"
    PIL_Image.new("RGBA", (60, 60), color=(0, 128, 255, 128)).save(p, format="PNG")
    return p


# ------------------------------------------------------------------ #
# convert_image — basic conversions (now synchronous)                  #
# ------------------------------------------------------------------ #


def test_convert_jpeg_to_png(svc: ConversionService, jpeg_source: Path) -> None:
    result = svc.convert_image(jpeg_source, target_format="png")
    assert result.suffix.lower() == ".png"
    assert result.exists()


def test_convert_png_to_jpeg(svc: ConversionService, png_source: Path) -> None:
    result = svc.convert_image(png_source, target_format="jpeg")
    assert result.suffix.lower() == ".jpg"
    assert result.exists()


def test_convert_rgba_png_to_jpeg_flattens_alpha(svc: ConversionService, rgba_png: Path) -> None:
    """RGBA → JPEG must flatten alpha channel without error."""
    result = svc.convert_image(rgba_png, target_format="jpeg")
    assert result.exists()
    PIL_Image = pytest.importorskip("PIL.Image")
    with PIL_Image.open(result) as img:
        assert img.mode == "RGB"


def test_convert_jpeg_to_jpeg_same_format_noop(svc: ConversionService, jpeg_source: Path) -> None:
    """JPEG → jpeg is a no-op: returns source path unchanged, no new file created."""
    result = svc.convert_image(jpeg_source, target_format="jpeg")
    assert result == jpeg_source
    assert result.exists()


def test_convert_image_preserves_exif_by_default(svc: ConversionService, jpeg_source: Path) -> None:
    """EXIF should be preserved when converting JPEG → JPEG (no-op, EXIF already there)."""
    piexif = pytest.importorskip("piexif")
    result = svc.convert_image(jpeg_source, target_format="jpeg", preserve_exif=True)
    # No-op returns source — which already holds the EXIF.
    assert result == jpeg_source
    exif = piexif.load(str(result))
    date_bytes = exif.get("Exif", {}).get(piexif.ExifIFD.DateTimeOriginal)
    assert date_bytes == b"2024:01:15 10:00:00"


def test_convert_image_quality_parameter_accepted(
    svc: ConversionService, jpeg_source: Path
) -> None:
    """quality parameter accepted without error (no-op for same-format source)."""
    result = svc.convert_image(jpeg_source, target_format="jpeg", quality=75)
    assert result.exists()


def test_convert_image_missing_source_raises(svc: ConversionService, tmp_path: Path) -> None:
    with pytest.raises(RuntimeError):
        svc.convert_image(tmp_path / "ghost.png", target_format="jpeg")


# ------------------------------------------------------------------ #
# _load_exif (static helper)                                             #
# ------------------------------------------------------------------ #


def test_load_exif_returns_none_for_missing_file(tmp_path: Path) -> None:
    result = ConversionService._load_exif(tmp_path / "ghost.jpg")
    assert result is None


def test_load_exif_returns_dict_for_exif_jpeg(jpeg_source: Path) -> None:
    result = ConversionService._load_exif(jpeg_source)
    assert result is not None
    assert isinstance(result, dict)


# ------------------------------------------------------------------ #
# New format targets                                                     #
# ------------------------------------------------------------------ #


def test_convert_jpeg_to_webp(svc: ConversionService, jpeg_source: Path) -> None:
    """JPEG → WEBP produces a valid .webp file."""
    PIL_Image = pytest.importorskip("PIL.Image")
    result = svc.convert_image(jpeg_source, target_format="webp")
    assert result.suffix.lower() == ".webp"
    assert result.exists()
    with PIL_Image.open(result) as img:
        assert img.format == "WEBP"


def test_convert_jpeg_to_webp_carries_exif(svc: ConversionService, jpeg_source: Path) -> None:
    """JPEG → WEBP carries EXIF bytes when present."""
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("piexif")
    result = svc.convert_image(jpeg_source, target_format="webp", preserve_exif=True)
    assert result.exists()
    with PIL_Image.open(result) as img:
        exif_bytes = img.info.get("exif")
    # Pillow exposes EXIF in WebP info when present.
    assert exif_bytes is not None and len(exif_bytes) > 0


def test_convert_jpeg_to_tiff(svc: ConversionService, jpeg_source: Path) -> None:
    """JPEG → TIFF produces a valid .tif file."""
    PIL_Image = pytest.importorskip("PIL.Image")
    result = svc.convert_image(jpeg_source, target_format="tiff")
    assert result.suffix.lower() == ".tif"
    assert result.exists()
    with PIL_Image.open(result) as img:
        assert img.format == "TIFF"


# ------------------------------------------------------------------ #
# No-op cases                                                           #
# ------------------------------------------------------------------ #


def test_noop_jpg_to_jpeg(svc: ConversionService, jpeg_source: Path) -> None:
    """.jpg source with target_format="jpeg" is a no-op."""
    result = svc.convert_image(jpeg_source, target_format="jpeg")
    assert result == jpeg_source


def test_noop_tif_to_tiff(svc: ConversionService, tiff_source: Path) -> None:
    """.tif source with target_format="tiff" is a no-op."""
    result = svc.convert_image(tiff_source, target_format="tiff")
    assert result == tiff_source


def test_noop_png_to_png(svc: ConversionService, png_source: Path) -> None:
    """.png source with target_format="png" is a no-op."""
    result = svc.convert_image(png_source, target_format="png")
    assert result == png_source


# ------------------------------------------------------------------ #
# Collision avoidance                                                   #
# ------------------------------------------------------------------ #


def test_convert_collision_avoidance(svc: ConversionService, tmp_path: Path) -> None:
    """When the target name is already taken, find_available_filename gives a unique path."""
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "photo.jpg"
    PIL_Image.new("RGB", (20, 20)).save(source, format="JPEG")

    # Pre-create the expected output name so there is a collision.
    (tmp_path / "photo.png").touch()

    result = svc.convert_image(source, target_format="png")
    assert result != tmp_path / "photo.png"
    assert result.exists()
    # The pre-existing stub is untouched (empty).
    assert (tmp_path / "photo.png").stat().st_size == 0


# ------------------------------------------------------------------ #
# Unknown target raises ValueError                                       #
# ------------------------------------------------------------------ #


def test_convert_image_unknown_format_raises(svc: ConversionService, jpeg_source: Path) -> None:
    with pytest.raises(ValueError, match="Unsupported image_format"):
        svc.convert_image(jpeg_source, target_format="gif")


def test_convert_image_bmp_format_raises(svc: ConversionService, jpeg_source: Path) -> None:
    with pytest.raises(ValueError):
        svc.convert_image(jpeg_source, target_format="bmp")


# ------------------------------------------------------------------ #
# HEIC source (skip if pillow-heif unavailable)                         #
# ------------------------------------------------------------------ #


def test_convert_heic_to_jpeg(svc: ConversionService, tmp_path: Path) -> None:
    """HEIC → JPEG works when pillow-heif is available."""
    pillow_heif = pytest.importorskip("pillow_heif")
    PIL_Image = pytest.importorskip("PIL.Image")

    pillow_heif.register_heif_opener()
    # Build a tiny HEIC from a PIL image (pillow-heif provides a save hook).
    source = tmp_path / "photo.heic"
    try:
        PIL_Image.new("RGB", (32, 32), color=(128, 64, 32)).save(source, format="HEIF")
    except Exception:
        pytest.skip("pillow-heif cannot encode HEIC in this environment")

    result = svc.convert_image(source, target_format="jpeg")
    assert result.suffix.lower() == ".jpg"
    assert result.exists()
    with PIL_Image.open(result) as img:
        assert img.format == "JPEG"


# ------------------------------------------------------------------ #
# convert_video                                                          #
# ------------------------------------------------------------------ #


@pytest.fixture()
def tiny_mp4(tmp_path: Path) -> Path:
    """Generate a tiny synthetic mp4 via ffmpeg's testsrc filter."""
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")
    out = tmp_path / "clip.mp4"
    result = __import__("subprocess").run(
        [
            "ffmpeg",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=32x32:rate=5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-y",
            str(out),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        pytest.skip("ffmpeg testsrc generation failed")
    return out


def test_convert_video_mp4_to_webm(svc: ConversionService, tiny_mp4: Path) -> None:
    """mp4 → webm produces a readable .webm file."""
    result = svc.convert_video(tiny_mp4, target_format="webm")
    assert result.suffix.lower() == ".webm"
    assert result.exists()
    # Confirm ffprobe can read it.
    probe = __import__("subprocess").run(
        ["ffprobe", "-v", "error", str(result)],
        capture_output=True,
    )
    assert probe.returncode == 0


def test_convert_video_mp4_to_mkv(svc: ConversionService, tiny_mp4: Path) -> None:
    result = svc.convert_video(tiny_mp4, target_format="mkv")
    assert result.suffix.lower() == ".mkv"
    assert result.exists()


def test_convert_video_mp4_to_mp4_noop(svc: ConversionService, tiny_mp4: Path) -> None:
    """mp4 → mp4 is a no-op: same path returned, no ffmpeg invoked."""
    with patch("subprocess.run") as mock_run:
        result = svc.convert_video(tiny_mp4, target_format="mp4")
    assert result == tiny_mp4
    mock_run.assert_not_called()


def test_convert_video_unknown_format_raises(svc: ConversionService, tiny_mp4: Path) -> None:
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")
    with pytest.raises(ValueError, match="Unsupported video_format"):
        svc.convert_video(tiny_mp4, target_format="flv")


def test_convert_video_ffmpeg_missing_raises(svc: ConversionService, tmp_path: Path) -> None:
    """When ffmpeg is not found, RuntimeError with a clear message is raised."""
    fake_mp4 = tmp_path / "clip.avi"
    fake_mp4.write_bytes(b"fake")
    with patch("subprocess.run", side_effect=FileNotFoundError):
        with pytest.raises(RuntimeError, match="ffmpeg not found"):
            svc.convert_video(fake_mp4, target_format="mp4")


def test_convert_video_timeout_reraises(svc: ConversionService, tmp_path: Path) -> None:
    """A conversion timeout propagates as TimeoutExpired (Bug M4 logging path)."""
    import subprocess as sp

    src = tmp_path / "clip.avi"
    src.write_bytes(b"fake")
    timeout_exc = sp.TimeoutExpired(cmd="ffmpeg", timeout=3600)
    with patch("subprocess.run", side_effect=timeout_exc):
        with pytest.raises(sp.TimeoutExpired):
            svc.convert_video(src, target_format="mp4")


def test_ffmpeg_timeout_constant_is_one_hour() -> None:
    """Bug L3: the timeout is a named constant, not a magic number."""
    from app.services.conversion_service import _FFMPEG_TIMEOUT_SECONDS

    assert _FFMPEG_TIMEOUT_SECONDS == 3600


# ------------------------------------------------------------------ #
# Sort integration                                                       #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_sort_integration_converts_jpeg_to_png(tmp_path: Path) -> None:
    """With convert_images=True/image_format="png", dest_path ends in .png."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    from app.core.config import Config
    from app.services.config_service import ConfigService
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateRegistry, DuplicateService
    from app.services.extraction_service import DateExtractionService
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService
    from app.services.repair_service import RepairService
    from app.services.sorting_service import SortingService

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir()
    dest_root.mkdir()

    img_path = source_root / "shot.jpg"
    PIL_Image.new("RGB", (40, 40)).save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 12:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        remove_duplicates=False,
        convert_images=True,
        image_format="png",
    )
    svc = SortingService(
        config=cfg,
        config_service=ConfigService(cfg),
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
        db_manager=None,
    )

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_conv_test",
    )

    assert record["status"] == "success"
    assert record["dest_path"].endswith(".png"), record["dest_path"]
    # The intermediate .jpg copy should not remain at that path.
    dest = Path(record["dest_path"])
    assert dest.exists()
    assert not dest.with_suffix(".jpg").exists() or dest.with_suffix(".jpg") == dest


@pytest.mark.asyncio
async def test_sort_integration_conversion_failure_keeps_original(tmp_path: Path) -> None:
    """When convert_image raises, the sort record is still success with the original file kept."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    from app.core.config import Config
    from app.services.config_service import ConfigService
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateRegistry, DuplicateService
    from app.services.extraction_service import DateExtractionService
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService
    from app.services.repair_service import RepairService
    from app.services.sorting_service import SortingService

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir()
    dest_root.mkdir()

    img_path = source_root / "shot.jpg"
    PIL_Image.new("RGB", (40, 40)).save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 12:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        remove_duplicates=False,
        convert_images=True,
        image_format="webp",
    )
    svc = SortingService(
        config=cfg,
        config_service=ConfigService(cfg),
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
        db_manager=None,
    )

    with patch.object(svc._conversion, "convert_image", side_effect=RuntimeError("boom")):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=cfg,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_fail_test",
        )

    assert record["status"] == "success"
    # The un-converted .jpg must still exist at dest_path.
    assert record["dest_path"].endswith(".jpg"), record["dest_path"]
    assert Path(record["dest_path"]).exists()
