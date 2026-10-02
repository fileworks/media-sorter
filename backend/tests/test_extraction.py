"""Tests for date extraction fallback chain."""

from datetime import date
from pathlib import Path

import pytest

from app.services.extraction_service import DateExtractionService


def _extract(svc: DateExtractionService, path: Path) -> "tuple[date | None, str]":
    """Drive the real entry point and unpack to the legacy (date, source) pair."""
    r = svc.extract_detailed(path, check_suspicious=False)
    return r.extracted_date, r.source


@pytest.fixture
def service() -> DateExtractionService:
    return DateExtractionService()


def test_filename_pattern_dashes(tmp_path: Path, service: DateExtractionService) -> None:
    f = tmp_path / "2023-07-04_holiday.jpg"
    f.touch()
    d, source = _extract(service, f)
    assert d == date(2023, 7, 4)
    assert source == "filename"


def test_filename_pattern_underscores(tmp_path: Path, service: DateExtractionService) -> None:
    f = tmp_path / "2022_12_25_christmas.jpg"
    f.touch()
    d, source = _extract(service, f)
    assert d == date(2022, 12, 25)
    assert source == "filename"


def test_filename_compact(tmp_path: Path, service: DateExtractionService) -> None:
    f = tmp_path / "IMG_20210101.jpg"
    f.touch()
    d, source = _extract(service, f)
    assert d == date(2021, 1, 1)
    assert source == "filename"


def test_filesystem_fallback(tmp_path: Path, service: DateExtractionService) -> None:
    f = tmp_path / "no_date_in_name.jpg"
    f.touch()
    d, source = _extract(service, f)
    assert d is not None
    assert source == "filesystem"
