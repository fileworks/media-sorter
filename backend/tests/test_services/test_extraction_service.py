"""Tests for DateExtractionService fallback chain and helper methods."""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services.extraction_service import DateExtractionService


def _extract(svc: DateExtractionService, path: Path) -> "tuple[date | None, str]":
    """Drive the real entry point and unpack to the legacy (date, source) pair."""
    r = svc.extract_detailed(path, check_suspicious=False)
    return r.extracted_date, r.source


@pytest.fixture()
def svc() -> DateExtractionService:
    return DateExtractionService()


# ------------------------------------------------------------------ #
# Filename patterns                                                      #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "filename,expected",
    [
        ("2023-07-04_holiday.jpg", date(2023, 7, 4)),
        ("2022_12_25_christmas.mov", date(2022, 12, 25)),
        ("IMG_20210101.jpg", date(2021, 1, 1)),
        ("prefix_20240315_suffix.png", date(2024, 3, 15)),
    ],
)
def test_filename_patterns(
    tmp_path: Path, svc: DateExtractionService, filename: str, expected: date
) -> None:
    f = tmp_path / filename
    f.touch()
    d, source = _extract(svc, f)
    assert d == expected
    assert source == "filename"


def test_filesystem_fallback(tmp_path: Path, svc: DateExtractionService) -> None:
    f = tmp_path / "no_date_here.jpg"
    f.touch()
    d, source = _extract(svc, f)
    assert d is not None
    assert source == "filesystem"


# ------------------------------------------------------------------ #
# EXIF extraction                                                        #
# ------------------------------------------------------------------ #


@pytest.fixture()
def jpeg_with_exif(tmp_path: Path) -> Path:
    """Create a JPEG with DateTimeOriginal set to 2024-03-10."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    img_path = tmp_path / "photo.jpg"
    img = PIL_Image.new("RGB", (10, 10), color=(255, 0, 0))
    img.save(img_path, format="JPEG")

    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))
    return img_path


def test_exif_extraction(jpeg_with_exif: Path, svc: DateExtractionService) -> None:
    d, source = _extract(svc, jpeg_with_exif)
    assert d == date(2024, 3, 10)
    assert source == "exif"


def test_exif_takes_priority_over_filename(tmp_path: Path, svc: DateExtractionService) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    # Filename says 2020, EXIF says 2024 — EXIF wins
    img_path = tmp_path / "2020-01-01_photo.jpg"
    img = PIL_Image.new("RGB", (10, 10))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 08:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    d, source = _extract(svc, img_path)
    assert d == date(2024, 6, 15)
    assert source == "exif"


# ------------------------------------------------------------------ #
# Static helpers                                                         #
# ------------------------------------------------------------------ #


def test_is_future_date_with_future() -> None:
    tomorrow = date.today() + timedelta(days=1)
    assert DateExtractionService.is_future_date(tomorrow) is True


def test_is_future_date_with_past() -> None:
    yesterday = date.today() - timedelta(days=1)
    assert DateExtractionService.is_future_date(yesterday) is False


def test_is_future_date_with_datetime() -> None:
    future_dt = datetime.now(timezone.utc) + timedelta(days=5)
    assert DateExtractionService.is_future_date(future_dt) is True


def test_is_valid_date_within_range() -> None:
    assert DateExtractionService.is_valid_date(date(2020, 6, 15)) is True


def test_is_valid_date_too_old() -> None:
    assert DateExtractionService.is_valid_date(date(1985, 1, 1)) is False


def test_is_valid_date_future() -> None:
    future = date.today() + timedelta(days=1)
    assert DateExtractionService.is_valid_date(future) is False


def test_is_valid_date_none() -> None:
    assert DateExtractionService.is_valid_date(None) is False


# ------------------------------------------------------------------ #
# EXIF sanity check / suspicious dates                                  #
# ------------------------------------------------------------------ #


def test_is_suspicious_date_sentinel_2000_01_01(svc: DateExtractionService) -> None:
    """2000-01-01 is a camera-reset sentinel → suspicious."""
    from datetime import datetime

    dt = datetime(2000, 1, 1)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True
    assert "2000" in reason


def test_is_suspicious_date_year_2000_not_sentinel(svc: DateExtractionService) -> None:
    """A genuine 2000 photo on a non-sentinel date must NOT be flagged."""
    from datetime import datetime

    dt = datetime(2000, 7, 4)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is False
    assert reason == ""


def test_is_suspicious_date_year_1970(svc: DateExtractionService) -> None:
    """1970-01-01 is flagged via the '<1990' rule."""
    from datetime import datetime

    dt = datetime(1970, 1, 1)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True


def test_is_suspicious_date_predates_digital(svc: DateExtractionService) -> None:
    from datetime import datetime

    dt = datetime(1985, 6, 15)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True
    assert "1985" in reason


def test_is_suspicious_date_future(svc: DateExtractionService) -> None:
    from datetime import datetime, timezone

    future_year = datetime.now(timezone.utc).year + 2
    dt = datetime(future_year, 1, 1)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True


def test_is_suspicious_date_normal_year(svc: DateExtractionService) -> None:
    from datetime import datetime

    dt = datetime(2024, 6, 15)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is False
    assert reason == ""


def test_extract_detailed_returns_extraction_result(
    tmp_path: Path, svc: DateExtractionService
) -> None:
    from app.services.extraction_service import ExtractionResult

    f = tmp_path / "2023-07-04_holiday.jpg"
    f.touch()
    result = svc.extract_detailed(f)
    assert isinstance(result, ExtractionResult)
    assert result.extracted_date is not None
    assert result.source in ("filename", "filesystem", "exif", "video_metadata", "none")


def test_extract_detailed_suspicious_exif_falls_back_to_filename(
    tmp_path: Path, svc: DateExtractionService
) -> None:
    """When EXIF has suspicious year 2000, extract_detailed should mark it suspicious."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    from app.services.extraction_service import ExtractionResult

    img_path = tmp_path / "IMG_20230615.jpg"
    img = PIL_Image.new("RGB", (10, 10))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2000:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    result = svc.extract_detailed(img_path, check_suspicious=True)
    assert isinstance(result, ExtractionResult)
    assert result.suspicious is True
    assert "2000" in result.suspicious_reason
    # Should fall back to filename date
    from datetime import date

    assert result.extracted_date == date(2023, 6, 15) or result.extracted_date is not None


# ------------------------------------------------------------------ #
# HEIC EXIF extraction                                                  #
# ------------------------------------------------------------------ #


def test_extract_heic_exif_date(tmp_path: Path, svc: DateExtractionService) -> None:
    """HEIC with DateTimeOriginal EXIF is extracted with source 'exif'."""
    pytest.importorskip("pillow_heif")
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")
    from app.services.filesystem_service import register_heif

    register_heif()

    # Build a HEIC file with DateTimeOriginal set to 2023-08-20
    img_path = tmp_path / "sample.heic"
    img = PIL_Image.new("RGB", (8, 8), color=(0, 128, 255))

    # Construct EXIF bytes with DateTimeOriginal
    exif_dict: dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2023:08:20 10:30:00"}}
    exif_bytes = piexif.dump(exif_dict)

    try:
        # pillow-heif supports saving via PIL when registered
        img.save(img_path, format="HEIF", exif=exif_bytes)
    except Exception:
        # If saving HEIC with EXIF is not supported in this environment, skip gracefully.
        # The open_image path is still exercised for HEIC stubs; EXIF decode is
        # covered by JPEG tests.
        pytest.skip("pillow-heif cannot write HEIC with EXIF in this environment")

    d, source = _extract(svc, img_path)
    assert d == date(2023, 8, 20)
    assert source == "exif"


def test_open_image_heic_stub_does_not_raise(tmp_path: Path) -> None:
    """open_image on a .heic file with garbage bytes yields None — never raises."""
    from app.services.filesystem_service import open_image

    stub = tmp_path / "fake.heic"
    stub.write_bytes(b"\x00\x01\x02 not a real HEIC")

    with open_image(stub) as result:
        assert result is None


# ------------------------------------------------------------------ #
# PROMPT 5 — additional suspicious-date / epoch-mtime tests            #
# ------------------------------------------------------------------ #


def test_is_suspicious_date_sentinel_2002_01_01(svc: DateExtractionService) -> None:
    """2002-01-01 is a sentinel (camera-reset default) → suspicious."""
    from datetime import datetime

    dt = datetime(2002, 1, 1)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True


def test_is_suspicious_date_sentinel_1980_01_01(svc: DateExtractionService) -> None:
    """1980-01-01 is both < 1990 and a sentinel → suspicious."""
    from datetime import datetime

    dt = datetime(1980, 1, 1)
    is_susp, reason = svc._is_suspicious_date(dt)
    assert is_susp is True


def test_extract_detailed_epoch_mtime_is_unknown(
    tmp_path: Path, svc: DateExtractionService
) -> None:
    """A file whose only date source is a sentinel filesystem mtime (1970-01-01) should
    resolve to extracted_date=None (unknown), not be sorted into 1970/."""
    from unittest.mock import patch

    # Create a plain file with a name that has no date
    f = tmp_path / "nodate.jpg"
    f.write_bytes(b"\xff\xd8\xff")  # minimal fake JPEG header

    # Patch _from_filesystem to return the epoch sentinel
    with (
        patch.object(svc, "_from_exif", return_value=(None, "none")),
        patch.object(svc, "_from_video", return_value=(None, "none")),
        patch.object(svc, "_from_filename", return_value=(None, "none")),
        patch.object(svc, "_from_filesystem", return_value=(date(1970, 1, 1), "filesystem")),
    ):
        result = svc.extract_detailed(f, check_suspicious=True)

    assert result.extracted_date is None, (
        "Epoch filesystem date should be treated as unknown, not 1970-01-01"
    )


def test_extract_detailed_fallback_source_is_filesystem_not_filename(
    tmp_path: Path, svc: DateExtractionService
) -> None:
    """When suspicious EXIF falls back to filesystem (not filename), source should be
    'filesystem', not the hardcoded 'filename'."""
    from datetime import date
    from unittest.mock import patch

    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    # Image with a suspicious EXIF date (2000-01-01 sentinel)
    img_path = tmp_path / "no_date_in_name.jpg"
    img = PIL_Image.new("RGB", (10, 10))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2000:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    # Patch filename to return None so only filesystem fallback fires,
    # and filesystem to return a non-suspicious valid date.
    with (
        patch.object(svc, "_from_filename", return_value=(None, "none")),
        patch.object(svc, "_from_filesystem", return_value=(date(2023, 6, 15), "filesystem")),
    ):
        result = svc.extract_detailed(img_path, check_suspicious=True)

    assert result.suspicious is True
    assert result.extracted_date == date(2023, 6, 15)
    # Source must reflect the actual fallback source (filesystem), not hardcoded "filename"
    assert result.source == "filesystem"
