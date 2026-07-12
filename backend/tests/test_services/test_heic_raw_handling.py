"""P0-3 — HEIC and RAW files are never silently dropped.

Each fixture must either be *placed* (date + optional perceptual signature) or
be *cleanly quarantined* with a reason in the record — the pipeline must not
skip or crash on them.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import piexif
import pillow_heif
from PIL import Image

from app.core.config import Config
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.duplicate_service import DuplicateRegistry, DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService


def _heic_with_exif(path: Path, date_str: str = "2022:08:15 12:00:00") -> Path:
    pillow_heif.register_heif_opener()
    img = Image.new("RGB", (320, 240), color=(30, 90, 160))
    exif_bytes = piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: date_str.encode()}})
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, exif=exif_bytes)
    return path


def _fake_dng(path: Path) -> Path:
    """A TIFF-container file with a .dng suffix — rawpy cannot demosaic it,
    which is exactly the degraded case P0-3 guards: no signature, still placed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color=(120, 60, 20)).save(path, format="TIFF")
    return path


def _service(tmp_path: Path, **overrides: Any) -> SortingService:
    defaults: dict = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "target"),
        "sort_criteria": ["year", "month", "day"],
        "copy_instead_of_move": True,
        "remove_duplicates": True,
        "duplicate_perceptual_enabled": True,
        "repair_enabled": False,
    }
    defaults.update(overrides)
    (tmp_path / "source").mkdir(exist_ok=True)
    (tmp_path / "target").mkdir(exist_ok=True)
    cfg = Config(**defaults)
    return SortingService(
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


class _FakeTask:
    class _Progress:
        current: int = 0
        total: int = 0
        percentage: float = 0.0
        estimated_time_remaining_seconds: float | None = None
        phase: str = ""

    def __init__(self) -> None:
        self.progress = self._Progress()
        self.cancel_event = asyncio.Event()


class TestHeic:
    def test_exif_date_is_extracted(self, tmp_path: Path) -> None:
        heic = _heic_with_exif(tmp_path / "IMG_0001.heic")
        result = DateExtractionService().extract_detailed(heic)
        assert str(result.extracted_date) == "2022-08-15"
        assert result.source == "exif"

    def test_perceptual_signature_exists(self, tmp_path: Path) -> None:
        heic = _heic_with_exif(tmp_path / "IMG_0001.heic")
        sig = DuplicateService().image_signature(heic)
        assert sig is not None
        assert sig.mean_rgb is not None

    def test_sorted_into_exif_date_folder(self, tmp_path: Path) -> None:
        _heic_with_exif(tmp_path / "source" / "IMG_0001.heic")
        svc = _service(tmp_path)
        stats = asyncio.run(svc.run(_FakeTask()))
        assert stats["sorted"] == 1
        assert (tmp_path / "target" / "2022" / "08" / "15" / "IMG_0001.heic").is_file()

    def test_heic_duplicate_pair_detected(self, tmp_path: Path) -> None:
        a = _heic_with_exif(tmp_path / "a.heic")
        b = tmp_path / "b.heic"
        b.write_bytes(a.read_bytes())
        svc = DuplicateService()
        registry = DuplicateRegistry()
        assert not svc.check_duplicate(a, registry).is_duplicate
        assert svc.check_duplicate(b, registry).is_duplicate


class TestRawDegradedPath:
    """A RAW file rawpy can't decode must still flow through — never vanish."""

    def test_signature_failure_returns_none_and_logs(self, tmp_path: Path) -> None:
        from structlog.testing import capture_logs

        dng = _fake_dng(tmp_path / "IMG_5555.dng")
        svc = DuplicateService()
        assert svc.image_signature(dng) is None  # rawpy can't decode the fake
        with capture_logs() as logs:
            match = svc.check_duplicate(dng, DuplicateRegistry(), perceptual=True)
        assert not match.is_duplicate  # degraded, not dropped
        assert any("No perceptual signature" in log["event"] for log in logs)

    def test_placed_by_filename_date_despite_no_signature(self, tmp_path: Path) -> None:
        _fake_dng(tmp_path / "source" / "2023-05-10_shoot.dng")
        svc = _service(tmp_path)
        stats = asyncio.run(svc.run(_FakeTask()))
        assert stats["sorted"] == 1
        assert stats["failed"] == 0
        assert (tmp_path / "target" / "2023" / "05" / "10" / "2023-05-10_shoot.dng").is_file()

    def test_exact_dedup_still_works_without_signature(self, tmp_path: Path) -> None:
        a = _fake_dng(tmp_path / "source" / "2023-05-10_a.dng")
        b = tmp_path / "source" / "2023-05-10_b.dng"
        (tmp_path / "source").mkdir(exist_ok=True)
        b.write_bytes(a.read_bytes())
        svc = _service(tmp_path)
        stats = asyncio.run(svc.run(_FakeTask()))
        assert stats["sorted"] == 1
        assert stats["duplicates"] == 1  # byte-identical twin caught by SHA-256
