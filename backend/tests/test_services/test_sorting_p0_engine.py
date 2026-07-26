"""Integration tests for the P0 engine work: junk routing, destination-aware
cross-run dedup, structure-preserving quarantine, and sort↔preview parity for
the new outcomes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import patch

from PIL import Image

from app.core.config import Config
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService, ExtractionResult
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.preview_service import PreviewService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService


def _photo(path: Path, seed: int = 0) -> Path:
    """A deterministic noise JPEG — poorly compressible, so it reliably clears
    the junk size floor while staying unique per seed."""
    import random

    rng = random.Random(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = bytes(rng.randrange(256) for _ in range(256 * 256 * 3))
    Image.frombytes("RGB", (256, 256), raw).save(path, quality=95)
    return path


def _config(tmp_path: Path, **overrides: Any) -> Config:
    defaults: dict = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "target"),
        "sort_criteria": ["year", "month", "day"],
        "copy_instead_of_move": True,
        "remove_duplicates": False,
        "repair_enabled": False,
    }
    defaults.update(overrides)
    (tmp_path / "source").mkdir(exist_ok=True)
    (tmp_path / "target").mkdir(exist_ok=True)
    return Config(**defaults)


def _service(cfg: Config) -> SortingService:
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


def _preview_service() -> PreviewService:
    return PreviewService(
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        rule_engine_service=None,
        duplicate_service=DuplicateService(),
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


def _run(svc: SortingService, dry_run: bool = False) -> dict[str, Any]:
    return asyncio.run(svc.run(_FakeTask(), dry_run=dry_run))


# ------------------------------------------------------------------ #
# P0-2 — junk routing through the sort pipeline                         #
# ------------------------------------------------------------------ #


class TestJunkRouting:
    def test_junk_lands_in_junk_folder_and_source_survives(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path, junk_filter_enabled=True)
        thumb = tmp_path / "source" / "phone" / "IMG_1-thumb.jpg"
        thumb.parent.mkdir(parents=True)
        Image.new("RGB", (640, 480)).save(thumb)
        keeper = _photo(tmp_path / "source" / "phone" / "2024-03-10_real.jpg")

        stats = _run(_service(cfg))

        assert stats["junk"] == 1
        assert stats["sorted"] == 1
        # Structure-preserving quarantine: the source subfolder survives.
        assert (tmp_path / "target" / "_junk" / "phone" / "IMG_1-thumb.jpg").is_file()
        assert thumb.is_file()  # copy mode: source untouched
        assert keeper.is_file()
        assert (tmp_path / "target" / "2024" / "03" / "10" / "2024-03-10_real.jpg").is_file()

    def test_junk_filter_off_by_default(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path)
        thumb = tmp_path / "source" / "IMG_1-thumb.jpg"
        thumb.parent.mkdir(exist_ok=True)
        Image.new("RGB", (640, 480)).save(thumb)

        stats = _run(_service(cfg))
        assert stats["junk"] == 0
        assert not (tmp_path / "target" / "_junk").exists()


# ------------------------------------------------------------------ #
# P0-1 — destination-aware & cross-run dedup                            #
# ------------------------------------------------------------------ #


class TestDestinationAwareDedup:
    def test_source_file_already_in_destination_is_quarantined(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path, remove_duplicates=True)
        placed = _photo(tmp_path / "target" / "2024" / "03" / "10" / "a.jpg", seed=7)
        source_copy = tmp_path / "source" / "2024-03-10_a.jpg"
        source_copy.parent.mkdir(exist_ok=True)
        source_copy.write_bytes(placed.read_bytes())

        stats = _run(_service(cfg))

        assert stats["already_in_destination"] == 1
        assert stats["sorted"] == 0
        quarantined = tmp_path / "target" / "_already_in_destination" / "2024-03-10_a.jpg"
        assert quarantined.is_file()
        assert source_copy.is_file()  # copy mode: source untouched

    def test_destination_comparison_is_mandatory(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path, remove_duplicates=True)
        placed = _photo(tmp_path / "target" / "2024" / "03" / "10" / "a.jpg", seed=7)
        source_copy = tmp_path / "source" / "2024-03-10_a.jpg"
        source_copy.parent.mkdir(exist_ok=True)
        source_copy.write_bytes(placed.read_bytes())

        stats = _run(_service(cfg))

        assert stats["already_in_destination"] == 1
        assert stats["sorted"] == 0

    def test_cross_run_dedup_source_b_after_source_a(self, tmp_path: Path) -> None:
        """Sorting source B after source A quarantines A↔B duplicates (P0-1 acceptance)."""
        cfg_a = _config(tmp_path, remove_duplicates=True)
        _photo(tmp_path / "source" / "2024-03-10_holiday.jpg", seed=3)
        stats_a = _run(_service(cfg_a))
        assert stats_a["sorted"] == 1

        source_b = tmp_path / "source-b"
        source_b.mkdir()
        dupe = source_b / "2024-03-10_holiday-copy.jpg"
        dupe.write_bytes((tmp_path / "source" / "2024-03-10_holiday.jpg").read_bytes())
        _photo(source_b / "2024-04-01_new.jpg", seed=9)

        cfg_b = _config(
            tmp_path,
            source_directory=str(source_b),
            remove_duplicates=True,
        )
        stats_b = _run(_service(cfg_b))

        assert stats_b["already_in_destination"] == 1
        assert stats_b["sorted"] == 1
        assert (tmp_path / "target" / "2024" / "04" / "01" / "2024-04-01_new.jpg").is_file()

    def test_dry_run_does_not_touch_destination(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path, remove_duplicates=True)
        placed = _photo(tmp_path / "target" / "2024" / "03" / "10" / "a.jpg", seed=7)
        source_copy = tmp_path / "source" / "2024-03-10_a.jpg"
        source_copy.parent.mkdir(exist_ok=True)
        source_copy.write_bytes(placed.read_bytes())

        stats = _run(_service(cfg), dry_run=True)
        assert stats["already_in_destination"] == 1
        assert not (tmp_path / "target" / "_already_in_destination").exists()


# ------------------------------------------------------------------ #
# P0-4 — structure-preserving quarantine                                #
# ------------------------------------------------------------------ #


class TestQuarantineStructure:
    def test_unknown_dates_keep_source_subfolders(self, tmp_path: Path) -> None:
        cfg = _config(tmp_path)
        mystery = tmp_path / "source" / "old-hdd" / "camera-roll" / "mystery.jpg"
        _photo(mystery)

        with patch.object(
            DateExtractionService,
            "extract_detailed",
            return_value=ExtractionResult(extracted_date=None, source="none"),
        ):
            stats = _run(_service(cfg))

        assert stats["unknown_dates"] == 1
        assert (
            tmp_path / "target" / "_unknown_dates" / "old-hdd" / "camera-roll" / "mystery.jpg"
        ).is_file()


# ------------------------------------------------------------------ #
# Never-delete invariant across ALL new outcome paths                   #
# ------------------------------------------------------------------ #


class TestNeverDeleteInvariant:
    def test_no_source_file_deleted_in_copy_mode_with_everything_on(self, tmp_path: Path) -> None:
        """Junk, destination-dupe and run-dupe outcomes together: every source
        file survives byte-for-byte in copy mode."""
        cfg = _config(
            tmp_path,
            junk_filter_enabled=True,
            remove_duplicates=True,
        )
        placed = _photo(tmp_path / "target" / "2024" / "03" / "10" / "old.jpg", seed=1)

        source = tmp_path / "source"
        originals: dict[Path, bytes] = {}
        dest_copy = source / "2024-03-10_old.jpg"
        dest_copy.write_bytes(placed.read_bytes())
        originals[dest_copy] = dest_copy.read_bytes()
        run_dupe_a = _photo(source / "2024-04-01_x.jpg", seed=2)
        run_dupe_b = source / "2024-04-01_x-copy.jpg"
        run_dupe_b.write_bytes(run_dupe_a.read_bytes())
        thumb = source / "IMG-thumb.jpg"
        Image.new("RGB", (640, 480)).save(thumb)
        fresh = _photo(source / "2024-05-05_new.jpg", seed=3)
        for f in (run_dupe_a, run_dupe_b, thumb, fresh):
            originals[f] = f.read_bytes()

        stats = _run(_service(cfg))

        assert stats["sorted"] >= 1
        assert stats["junk"] == 1
        assert stats["already_in_destination"] == 1
        assert stats["duplicates"] == 1
        for f, content in originals.items():
            assert f.is_file(), f"source file vanished: {f}"
            assert f.read_bytes() == content, f"source file mutated: {f}"


# ------------------------------------------------------------------ #
# Preview parity — the preview is a promise the sort keeps              #
# ------------------------------------------------------------------ #


class TestPreviewParity:
    def test_preview_predicts_junk_and_destination_outcomes(self, tmp_path: Path) -> None:
        cfg = _config(
            tmp_path,
            junk_filter_enabled=True,
            remove_duplicates=True,
        )
        # already-in-destination case
        placed = _photo(tmp_path / "target" / "2024" / "03" / "10" / "a.jpg", seed=7)
        copy = tmp_path / "source" / "phone" / "2024-03-10_a.jpg"
        copy.parent.mkdir(parents=True)
        copy.write_bytes(placed.read_bytes())
        # junk case (in a subfolder, so structure preservation is exercised)
        thumb = tmp_path / "source" / "phone" / "IMG-thumb.jpg"
        Image.new("RGB", (640, 480)).save(thumb)
        # normal case
        _photo(tmp_path / "source" / "phone" / "2024-04-01_new.jpg", seed=11)

        preview = asyncio.run(_preview_service().preview(cfg))
        predicted = {item["source"]: item for item in preview["items"]}
        assert preview["stats"]["will_quarantine_junk"] == 1
        assert preview["stats"]["will_skip_already_in_destination"] == 1
        assert preview["stats"]["will_sort"] == 1
        assert predicted[str(thumb)]["quarantine_reason"] is not None

        stats = _run(_service(cfg))
        assert stats["junk"] == 1
        assert stats["already_in_destination"] == 1
        assert stats["sorted"] == 1

        # The three predicted destinations exist exactly where promised.
        for item in preview["items"]:
            assert item["destination"] is not None
            assert Path(item["destination"]).is_file(), item
