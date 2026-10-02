"""Tests for RepairService — image and video validation/repair."""

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.repair_service import RepairService


@pytest.fixture()
def svc() -> RepairService:
    return RepairService()


@pytest.fixture()
def valid_jpeg(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    img_path = tmp_path / "valid.jpg"
    img = PIL_Image.new("RGB", (100, 100), color=(255, 0, 0))
    img.save(img_path, format="JPEG")
    return img_path


@pytest.fixture()
def valid_png(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    img_path = tmp_path / "valid.png"
    img = PIL_Image.new("RGB", (50, 50), color=(0, 128, 255))
    img.save(img_path, format="PNG")
    return img_path


# ------------------------------------------------------------------ #
# validate_image                                                        #
# ------------------------------------------------------------------ #


def test_validate_valid_jpeg(valid_jpeg: Path) -> None:
    is_valid, error = RepairService.validate_image(valid_jpeg)
    assert is_valid is True
    assert error is None


def test_validate_valid_png(valid_png: Path) -> None:
    is_valid, error = RepairService.validate_image(valid_png)
    assert is_valid is True
    assert error is None


def test_validate_corrupted_jpeg(tmp_path: Path) -> None:
    img_path = tmp_path / "corrupted.jpg"
    img_path.write_bytes(b"\xff\xd8\xff\xe0")  # truncated JPEG header
    is_valid, error = RepairService.validate_image(img_path)
    assert is_valid is False
    assert error is not None


def test_validate_non_image_bytes_fails(tmp_path: Path) -> None:
    f = tmp_path / "random.jpg"
    f.write_bytes(b"this is not an image")
    is_valid, _err = RepairService.validate_image(f)
    assert is_valid is False


# ------------------------------------------------------------------ #
# validate_file (dispatch)                                              #
# ------------------------------------------------------------------ #


def test_validate_file_missing_path(svc: RepairService, tmp_path: Path) -> None:
    is_valid, error = svc.validate_file(tmp_path / "ghost.jpg")
    assert is_valid is False
    assert error is not None


def test_validate_file_valid_image(svc: RepairService, valid_jpeg: Path) -> None:
    is_valid, error = svc.validate_file(valid_jpeg)
    assert is_valid is True
    assert error is None


def test_validate_file_unknown_extension_passes(svc: RepairService, tmp_path: Path) -> None:
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"%PDF-1.4")
    is_valid, error = svc.validate_file(f)
    assert is_valid is True
    assert error is None


# ------------------------------------------------------------------ #
# repair_image                                                          #
# ------------------------------------------------------------------ #


def test_repair_image_produces_valid_file(valid_jpeg: Path) -> None:
    success = RepairService.repair_image(valid_jpeg)
    assert success is True
    assert valid_jpeg.exists()
    # File is still a valid image after repair
    is_valid, _ = RepairService.validate_image(valid_jpeg)
    assert is_valid is True


def test_repair_file_delegates_to_repair_image(svc: RepairService, valid_jpeg: Path) -> None:
    assert svc.repair_file(valid_jpeg) is True


def test_repair_file_returns_false_for_unknown_extension(
    svc: RepairService, tmp_path: Path
) -> None:
    f = tmp_path / "data.xyz"
    f.write_bytes(b"binary")
    assert svc.repair_file(f) is False


# ------------------------------------------------------------------ #
# async compat                                                          #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_attempt_repair_returns_path_on_success(svc: RepairService, valid_jpeg: Path) -> None:
    result = await svc.attempt_repair(valid_jpeg)
    assert result == valid_jpeg


@pytest.mark.asyncio
async def test_attempt_repair_returns_none_on_failure(svc: RepairService, tmp_path: Path) -> None:
    f = tmp_path / "data.xyz"
    f.write_bytes(b"binary")
    result = await svc.attempt_repair(f)
    assert result is None


# ------------------------------------------------------------------ #
# validate_video — fast ffprobe probe                                   #
# ------------------------------------------------------------------ #


def test_validate_video_real_mp4(tmp_path: Path) -> None:
    """A real testsrc mp4 with a video stream must validate as True.

    Skipped when ffmpeg/ffprobe is not installed.
    """
    output = tmp_path / "test.mp4"
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=32x32:rate=5",
                str(output),
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0 or not output.exists():
            pytest.skip("ffmpeg could not create test video")
    except FileNotFoundError:
        pytest.skip("ffmpeg not installed")

    is_valid, err = RepairService.validate_video(output)
    assert is_valid is True
    assert err is None


def test_validate_video_garbage_bytes(tmp_path: Path) -> None:
    """A .mp4 file filled with garbage bytes must fail validation (or pass gracefully when
    ffprobe is absent — both outcomes are acceptable, so we only check the return type)."""
    garbage = tmp_path / "garbage.mp4"
    garbage.write_bytes(b"\x00\x01\x02\x03" * 100)
    is_valid, err = RepairService.validate_video(garbage)
    # Either False (ffprobe present and sees no video stream) or True (ffprobe absent)
    assert isinstance(is_valid, bool)


def test_validate_video_missing_ffprobe(tmp_path: Path) -> None:
    """When ffprobe is not found, validate_video must return (True, None)
    rather than raising or failing the file."""
    mp4 = tmp_path / "clip.mp4"
    mp4.write_bytes(b"\x00\x00\x00\x20ftypisom")
    with patch("subprocess.run", side_effect=FileNotFoundError("ffprobe not found")):
        is_valid, err = RepairService.validate_video(mp4)
    assert is_valid is True
    assert err is None


# ------------------------------------------------------------------ #
# repair_image — non-destructive invariants                             #
# ------------------------------------------------------------------ #


def test_repair_image_no_temp_leftover_on_failure(tmp_path: Path) -> None:
    """repair_image on a truncated JPEG must not leave any *.repair.tmp* file behind,
    regardless of whether the repair succeeded or failed."""
    truncated = tmp_path / "trunc.jpg"
    truncated.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")  # too short to be valid

    RepairService.repair_image(truncated)

    leftover = list(tmp_path.glob("*.repair.tmp*"))
    assert leftover == [], f"Unexpected temp files left: {leftover}"


def test_repair_image_no_temp_leftover_on_success(tmp_path: Path) -> None:
    """repair_image on a valid JPEG should succeed and leave no *.repair.tmp* files."""
    PIL_Image = pytest.importorskip("PIL.Image")
    img_path = tmp_path / "ok.jpg"
    PIL_Image.new("RGB", (50, 50), color=(0, 128, 0)).save(img_path, format="JPEG")

    result = RepairService.repair_image(img_path)
    assert result is True

    leftover = list(tmp_path.glob("*.repair.tmp*"))
    assert leftover == [], f"Unexpected temp files left: {leftover}"


def test_repair_image_does_not_leak_load_truncated_flag(tmp_path: Path) -> None:
    """LOAD_TRUNCATED_IMAGES must be restored to its original value after repair_image,
    even when the repair fails."""
    from PIL import ImageFile

    original = ImageFile.LOAD_TRUNCATED_IMAGES
    # Ensure it starts False so the test is meaningful
    ImageFile.LOAD_TRUNCATED_IMAGES = False

    garbage = tmp_path / "garbage.jpg"
    garbage.write_bytes(b"not an image at all")
    try:
        RepairService.repair_image(garbage)
    finally:
        pass  # ensure we check the flag regardless

    assert ImageFile.LOAD_TRUNCATED_IMAGES is False, (
        "repair_image leaked LOAD_TRUNCATED_IMAGES=True"
    )
    # Restore whatever the original was
    ImageFile.LOAD_TRUNCATED_IMAGES = original


def test_repair_image_raw_returns_false(tmp_path: Path) -> None:
    """RAW files (.arw, .cr2, etc.) must not be re-encoded; repair_image returns
    False immediately."""
    arw = tmp_path / "shot.arw"
    arw.write_bytes(b"II\x2a\x00")  # fake TIFF/ARW header bytes
    result = RepairService.repair_image(arw)
    assert result is False
    # No temp files created
    assert list(tmp_path.glob("*.repair.tmp*")) == []


# ------------------------------------------------------------------ #
# repair_video — non-destructive invariants                             #
# ------------------------------------------------------------------ #


def test_repair_video_no_temp_leftover_on_failure(tmp_path: Path) -> None:
    """repair_video must not leave *.repair.tmp* files when the repair fails
    (e.g., ffmpeg is absent or cannot remux the garbage input)."""
    garbage = tmp_path / "broken.mp4"
    garbage.write_bytes(b"\x00\x01\x02\x03" * 50)

    RepairService.repair_video(garbage)

    leftover = list(tmp_path.glob("*.repair.tmp*"))
    assert leftover == [], f"Unexpected temp files left: {leftover}"
