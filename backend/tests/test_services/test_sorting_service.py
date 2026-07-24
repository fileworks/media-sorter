"""Unit tests for SortingService._process_file and helper methods."""

from __future__ import annotations

import asyncio
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from app.background_tasks.task_manager import Task
from app.core.config import Config
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.duplicate_service import DuplicateMatch, DuplicateRegistry, DuplicateService
from app.services.extraction_service import DateExtractionService, ExtractionResult
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService

# ------------------------------------------------------------------ #
# Helpers                                                               #
# ------------------------------------------------------------------ #


def _make_service(tmp_path: Path, **config_overrides: Any) -> SortingService:
    """Build a SortingService wired to real sub-services with temp directories."""
    defaults: dict = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "target"),
        "sort": True,
        "sort_criteria": ["year", "month", "day"],
        "copy_instead_of_move": True,
        "recursive_scan": True,
        "remove_duplicates": False,
    }
    defaults.update(config_overrides)
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
        db_manager=None,  # no DB for unit tests
    )


class _FakeTask:
    """Minimal task stand-in for SortingService.run()."""

    class _Progress:
        current: int = 0
        total: int = 0
        percentage: float = 0.0
        estimated_time_remaining_seconds: float | None = None

    def __init__(self) -> None:
        self.progress = self._Progress()
        self.cancel_event = asyncio.Event()


# ------------------------------------------------------------------ #
# _build_dest                                                           #
# ------------------------------------------------------------------ #


def test_build_dest_creates_year_month_day_structure(tmp_path: Path) -> None:
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    file_path = source_root / "photo.jpg"
    file_path.touch()

    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 3, 10),
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
    )

    assert "2024" in dest.parts
    assert "03" in dest.parts
    assert "10" in dest.parts
    assert dest.name == "photo.jpg"


def test_build_dest_avoids_overwrite(tmp_path: Path) -> None:
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)

    # Pre-create a file at the expected destination
    expected_dir = dest_root / "2024" / "03" / "10"
    expected_dir.mkdir(parents=True)
    (expected_dir / "photo.jpg").touch()

    file_path = source_root / "photo.jpg"
    file_path.touch()

    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 3, 10),
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
    )

    # Should rename to _001 variant
    assert dest.name == "photo_001.jpg"


# ------------------------------------------------------------------ #
# _process_file — success path                                          #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_process_file_success_with_exif(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path, copy_instead_of_move=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "photo.jpg"
    img = PIL_Image.new("RGB", (100, 100))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op_test",
    )

    assert record["status"] == "success"
    assert record["extracted_date"] == "2024-03-10"
    assert record["metadata_source"] == "exif"
    assert record["category"] is None  # categorize off by default


class _FakeClassifier:
    """Stand-in classifier returning a fixed category for every file."""

    def __init__(self, category: str | None) -> None:
        self._category = category

    def classify_file(self, path: Path) -> Any:
        from app.services.ai.category_classifier_service import CategoryResult

        return CategoryResult(self._category, 0.99, 0.9)


@pytest.mark.asyncio
async def test_process_file_records_and_routes_category(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path, copy_instead_of_move=True, categorize_enabled=True)
    svc._classifier = _FakeClassifier("food")
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "photo.jpg"
    PIL_Image.new("RGB", (100, 100)).save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op_test",
    )

    assert record["status"] == "success"
    assert record["category"] == "food"
    assert "food" in Path(str(record["dest_path"])).parts


@pytest.mark.asyncio
async def test_process_file_uncategorized_when_classifier_unsure(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path, copy_instead_of_move=True, categorize_enabled=True)
    svc._classifier = _FakeClassifier(None)  # below confidence bar
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "photo.jpg"
    PIL_Image.new("RGB", (100, 100)).save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op_test",
    )

    assert record["category"] is None
    assert "_uncategorized" in Path(str(record["dest_path"])).parts


@pytest.mark.asyncio
async def test_process_file_unknown_date(tmp_path: Path) -> None:
    """A file with no date at all → quarantine as unknown_date."""
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    # A JPEG with no EXIF and a filename that has no recognisable date
    img_path = source_root / "nodate_image.jpg"
    img = PIL_Image.new("RGB", (50, 50))
    img.save(img_path, format="JPEG")

    # Patch the extraction service so it returns None regardless of filesystem mtime
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=None, source="none"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=True,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "unknown_date"
    assert "_unknown_dates" in str(record["dest_path"])


@pytest.mark.asyncio
async def test_process_file_future_date(tmp_path: Path) -> None:
    """A file with a future date → quarantine as future_date."""
    from datetime import timedelta

    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "future.jpg"
    img_path.write_bytes(b"\xff\xd8\xff")  # fake JPEG bytes

    future = date.today() + timedelta(days=30)
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=future, source="exif"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=True,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "future_date"
    assert "_future_dates" in str(record["dest_path"])


@pytest.mark.asyncio
async def test_process_file_duplicate(tmp_path: Path) -> None:
    """A duplicate file → quarantine as duplicate (dry_run)."""
    svc = _make_service(tmp_path, remove_duplicates=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "dup.jpg"
    img_path.write_bytes(b"duplicate content")

    with (
        patch.object(
            svc._extraction,
            "extract_detailed",
            return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
        ),
        patch.object(
            svc._duplicates,
            "check_duplicate",
            return_value=DuplicateMatch(True, "exact", 100, "/orig"),
        ),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=True,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "duplicate"


# ------------------------------------------------------------------ #
# SortingService.run (async, dry_run=True)                              #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_run_dry_run_returns_stats(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Create 2 dated images
    for name, exif_ts in [("a.jpg", b"2024:01:15 10:00:00"), ("b.jpg", b"2023:06:01 08:00:00")]:
        p = source / name
        img = PIL_Image.new("RGB", (50, 50))
        img.save(p, format="JPEG")
        exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: exif_ts}}
        piexif.insert(piexif.dump(exif_dict), str(p))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort=True,
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        recursive_scan=True,
        remove_duplicates=False,
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

    task = _FakeTask()
    result = await svc.run(task, dry_run=True)

    assert result["total"] == 2
    assert result["sorted"] == 2
    assert result["failed"] == 0
    # dry_run → source files still exist
    assert (source / "a.jpg").exists()
    assert (source / "b.jpg").exists()


# ------------------------------------------------------------------ #
# Fix 2 regression: ConversionService wired but not invoked in dry_run #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_process_file_includes_tags_field(tmp_path: Path) -> None:
    """Record returned by _process_file always contains a 'tags' key."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path, copy_instead_of_move=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "shot.jpg"
    img = PIL_Image.new("RGB", (50, 50))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op_tags_test",
    )

    assert "tags" in record
    assert isinstance(record["tags"], list)


# ------------------------------------------------------------------ #
# Fix 3 regression: RuleEngineService integration                       #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_process_file_applies_rule_tags(tmp_path: Path) -> None:
    """When a RuleEngineService is present, tags are evaluated and stored."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    from app.services.rule_engine_service import RuleEngineService

    cfg = Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "target"),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        recursive_scan=True,
        remove_duplicates=False,
        rules_enabled=True,
        rules=[
            {
                "id": "r1",
                "name": "JPEG rule",
                "condition": {"type": "extension", "value": "jpg"},
                "tag": "JPEG_FILE",
            }
        ],
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
        rule_engine_service=RuleEngineService(config=cfg),
    )

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "tagged.jpg"
    img = PIL_Image.new("RGB", (50, 50))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op_rules_test",
    )

    assert record["status"] == "success"
    assert "JPEG_FILE" in record["tags"]


# ------------------------------------------------------------------ #
# preserve_subfolders controls source-subfolder recreation             #
# ------------------------------------------------------------------ #


def test_preserve_subfolders_recreates_structure(tmp_path: Path) -> None:
    """preserve_subfolders=True: file placed under date/subfolder/name."""
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    subdir = source_root / "vacation"
    subdir.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    file_path = subdir / "beach.jpg"
    file_path.touch()

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        preserve_subfolders=True,
    )

    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
    )

    assert "vacation" in dest.parts
    assert "2024" in dest.parts
    assert dest.name == "beach.jpg"


def test_preserve_subfolders_false_flattens(tmp_path: Path) -> None:
    """preserve_subfolders=False (default): file placed directly in YYYY/MM/DD/."""
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    subdir = source_root / "vacation"
    subdir.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    file_path = subdir / "beach.jpg"
    file_path.touch()

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        preserve_subfolders=False,
    )

    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
    )

    assert "vacation" not in dest.parts
    assert "2024" in dest.parts
    assert dest.name == "beach.jpg"


# ------------------------------------------------------------------ #
# _build_dest — Smart Categorization                                    #
# ------------------------------------------------------------------ #


def _build_dest_for(tmp_path: Path, category: str | None, **cfg: Any) -> Path:
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True, exist_ok=True)
    dest_root.mkdir(parents=True, exist_ok=True)
    file_path = source_root / "beach.jpg"
    file_path.touch()
    config = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        categorize_enabled=True,
        **cfg,
    )
    return svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=config,
        category=category,
    )


def test_build_dest_injects_category_segment(tmp_path: Path) -> None:
    dest = _build_dest_for(tmp_path, "food")
    assert dest.parts[-2] == "food"
    assert "2024" in dest.parts
    assert dest.name == "beach.jpg"


def test_build_dest_none_category_falls_back_to_uncategorized(tmp_path: Path) -> None:
    dest = _build_dest_for(tmp_path, None)
    assert dest.parts[-2] == "_uncategorized"


def test_build_dest_unsafe_category_falls_back_to_uncategorized(tmp_path: Path) -> None:
    # A category that sanitizes away entirely must not produce a broken path.
    dest = _build_dest_for(tmp_path, "..")
    assert dest.parts[-2] == "_uncategorized"


def test_build_dest_category_wins_over_preserve_subfolders(tmp_path: Path) -> None:
    # Mutual exclusion (D3): categorize on + preserve on ⇒ category wins.
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    subdir = source_root / "vacation"
    subdir.mkdir(parents=True)
    dest_root.mkdir(parents=True)
    file_path = subdir / "beach.jpg"
    file_path.touch()
    config = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        categorize_enabled=True,
        preserve_subfolders=True,
    )
    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=config,
        category="food",
    )
    assert "food" in dest.parts
    assert "vacation" not in dest.parts


def test_build_dest_category_then_camera_stacking(tmp_path: Path) -> None:
    # D4: topic and device are orthogonal → Y/M/D/<category>/<camera>/file.
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)
    file_path = source_root / "beach.jpg"
    file_path.touch()
    config = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        categorize_enabled=True,
        camera_subfolder_enabled=True,
    )
    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=config,
        category="food",
        camera="iPhone 15 Pro",
    )
    # …/food/iPhone 15 Pro/beach.jpg
    assert dest.parts[-3] == "food"
    assert dest.parts[-2] == "iPhone 15 Pro"


def test_build_dest_sanitizes_camera_model(tmp_path: Path) -> None:
    svc = _make_service(tmp_path)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)
    file_path = source_root / "beach.jpg"
    file_path.touch()
    config = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year"],
        camera_subfolder_enabled=True,
    )
    dest = svc._build_dest(
        file_path=file_path,
        extracted_date=date(2024, 7, 4),
        source_root=source_root,
        dest_root=dest_root,
        config=config,
        camera="CanonEOS",  # pre-sanitized (slashes stripped by sanitize_path_segment)
    )
    # The "/" in the camera model must not create a nested folder.
    assert dest.parts[-2] == "CanonEOS"


def test_from_dict_ignores_unknown_keys() -> None:
    """Unknown keys are dropped, not forwarded to the constructor.

    Covers the "$schema" marker, fields from a newer build, and the retired
    legacy keys (flatten_output/keep_folder_structure) — all silently ignored
    now that the migration shim is gone.
    """
    cfg = Config.from_dict(
        {
            "preserve_subfolders": True,
            "$schema": "mediasort-config-v1",
            "flatten_output": False,
            "dedup_against_destination": False,
            "remove_duplicates": True,
            "some_future_field": 123,
        }
    )
    assert cfg.preserve_subfolders is True
    assert not hasattr(cfg, "flatten_output")
    assert not hasattr(cfg, "dedup_against_destination")
    assert "dedup_against_destination" not in cfg.to_dict()
    assert cfg.remove_duplicates is True
    assert not hasattr(cfg, "some_future_field")


# ------------------------------------------------------------------ #
# SortingService.run — status counting branches (lines 119-128)       #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_run_counts_unknown_date_status(tmp_path: Path) -> None:
    """run() must increment unknown_dates when a file has no extractable date."""
    pytest.importorskip("PIL.Image")
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Plain JPEG with no date clues anywhere (name has no date, no EXIF)
    (source / "nodatephoto.jpg").write_bytes(
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    )

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
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

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=None, source="none"),
    ):
        stats = await svc.run(_FakeTask(), dry_run=True)

    assert stats["unknown_dates"] == 1
    assert stats["sorted"] == 0


@pytest.mark.asyncio
async def test_run_counts_future_date_status(tmp_path: Path) -> None:
    """run() must increment future_dates when EXIF date is in the future."""
    from datetime import timedelta

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    (source / "future.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
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

    future = date.today() + timedelta(days=30)
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=future, source="exif"),
    ):
        stats = await svc.run(_FakeTask(), dry_run=True)

    assert stats["future_dates"] == 1
    assert stats["sorted"] == 0


@pytest.mark.asyncio
async def test_run_counts_duplicate_status(tmp_path: Path) -> None:
    """run() must increment duplicates when a file is flagged as duplicate."""
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    (source / "dup.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        remove_duplicates=True,
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

    with (
        patch.object(
            svc._extraction,
            "extract_detailed",
            return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
        ),
        patch.object(
            svc._duplicates,
            "check_duplicate",
            return_value=DuplicateMatch(True, "exact", 100, "/orig"),
        ),
    ):
        stats = await svc.run(_FakeTask(), dry_run=True)

    assert stats["duplicates"] == 1
    assert stats["sorted"] == 0


@pytest.mark.asyncio
async def test_run_keeps_higher_resolution_duplicate_regardless_of_order(tmp_path: Path) -> None:
    """Requirement: of a perceptual-duplicate group the higher-resolution copy is
    kept (sorted into the date tree) and the lower-resolution copy is quarantined
    as the duplicate — even when the lower-res file is processed first by name."""
    pytest.importorskip("imagehash")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Same content (solid grey → identical phash), different resolutions. Names
    # make the LOW-res copy sort first alphabetically (list_files returns sorted
    # order); keeper selection must override that and still keep the high-res one.
    low = source / "a_low.jpg"
    high = source / "b_high.jpg"
    PIL_Image.new("RGB", (64, 64), color=(120, 120, 120)).save(low, format="JPEG", quality=95)
    PIL_Image.new("RGB", (256, 256), color=(120, 120, 120)).save(high, format="JPEG", quality=95)

    svc = _make_service(
        tmp_path,
        copy_instead_of_move=True,
        remove_duplicates=True,
        duplicate_exact_enabled=False,  # different bytes → exercise the perceptual path
        duplicate_perceptual_enabled=True,
        duplicate_perceptual_threshold=90,
        repair_enabled=False,
    )

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
    ):
        stats = await svc.run(_FakeTask(), dry_run=False)

    assert stats["sorted"] == 1
    assert stats["duplicates"] == 1
    # The HIGH-res copy is kept in the date tree; the LOW-res copy is quarantined.
    assert (target / "2024" / "01" / "01" / "b_high.jpg").exists()
    assert (target / "_duplicates" / "a_low.jpg").exists()
    assert not (target / "2024" / "01" / "01" / "a_low.jpg").exists()
    assert not (target / "_duplicates" / "b_high.jpg").exists()


@pytest.mark.asyncio
async def test_sort_restores_source_totals_after_destination_index(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    for number in range(2):
        (source / f"{number}.jpg").write_bytes(f"source-{number}".encode())
    (target / "existing.jpg").write_bytes(b"destination")

    svc = _make_service(
        tmp_path,
        remove_duplicates=True,
        duplicate_exact_enabled=True,
        duplicate_perceptual_enabled=True,
    )
    task = Task(id="sort-phases", operation_kind="sort")
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
    ):
        stats = await svc.run(task, dry_run=True)

    phase_totals = {
        event.phase: event.fields["total"]
        for event in task.events
        if event.name == "operation.phase"
    }
    destination_total = next(
        event.fields["total"]
        for event in task.events
        if event.name == "operation.destination_total"
    )
    assert destination_total == 1
    assert phase_totals["ranking"] == 2
    assert phase_totals["sorting"] == 2
    assert task.progress.phase == "sorting"
    assert task.progress.total == 2
    assert stats["total"] == 2


@pytest.mark.asyncio
async def test_run_counts_failed_status(tmp_path: Path) -> None:
    """run() must increment failed when _process_file raises an unhandled error."""
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    (source / "bad.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
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

    with patch.object(svc._extraction, "extract_detailed", side_effect=RuntimeError("boom")):
        stats = await svc.run(_FakeTask(), dry_run=True)

    assert stats["failed"] == 1


@pytest.mark.asyncio
async def test_run_cancel_stops_processing(tmp_path: Path) -> None:
    """Pre-cancelled task must exit without processing all files (lines 100-102)."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Create 5 dated images
    for i in range(5):
        p = source / f"img_{i}.jpg"
        PIL_Image.new("RGB", (10, 10)).save(p, format="JPEG")
        exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: f"202{i}:06:01 00:00:00".encode()}}
        piexif.insert(piexif.dump(exif), str(p))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
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

    task = _FakeTask()
    task.cancel_event.set()  # cancel immediately
    stats = await svc.run(task, dry_run=True)

    # Cancellation is observed by the shared traversal before enumeration.
    assert stats["total"] == 0
    assert stats["sorted"] == 0


@pytest.mark.asyncio
async def test_run_persists_to_db(tmp_path: Path, in_memory_db) -> None:
    """run() with a real DB should persist one operation row (line 147-153)."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    p = source / "2024-01-01_photo.jpg"
    PIL_Image.new("RGB", (10, 10)).save(p, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif), str(p))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
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
        db_manager=in_memory_db,
    )

    await svc.run(_FakeTask(), dry_run=False)

    with in_memory_db._connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM operations").fetchone()[0]
    assert count == 1


@pytest.mark.asyncio
async def test_run_cancelled_still_persists_partial_operation(tmp_path: Path, in_memory_db) -> None:
    """A cancelled (non-dry) run must still record its operation in the DB (P2-2).

    With cooperative cancellation the run loop breaks on the cancel event and
    falls through to ``_persist_operation`` — the history must show the partial
    run so the user can see which files were already moved/copied.
    """
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    p = source / "photo.jpg"
    PIL_Image.new("RGB", (10, 10)).save(p, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif), str(p))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year"],
        copy_instead_of_move=True,
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
        db_manager=in_memory_db,
    )

    task = _FakeTask()
    task.cancel_event.set()  # cancelled before any file is processed
    stats = await svc.run(task, dry_run=False)

    assert stats["sorted"] == 0
    with in_memory_db._connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM operations").fetchone()[0]
    assert count == 1


@pytest.mark.asyncio
async def test_process_file_apply_rename(tmp_path: Path) -> None:
    """_apply_rename must produce the renamed file path (lines 339-348)."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir()
    dest_root.mkdir()

    img_path = source_root / "shot.jpg"
    PIL_Image.new("RGB", (10, 10)).save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:15 10:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        rename=True,
        rename_pattern="TYPE_YYYY-MM-DD",
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
        rule_engine_service=None,
    )

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_rename_test",
    )

    assert record["status"] == "success"
    # Renamed file should have the pattern applied
    assert "IMG_2024-03-15" in record["dest_path"]


def test_safe_stat_returns_zero_for_missing_file(tmp_path: Path) -> None:
    """_safe_stat must return 0 rather than raising for a non-existent path (lines 367-368)."""
    missing = tmp_path / "does_not_exist.jpg"
    result = SortingService._safe_stat(missing)
    assert result == 0


# ------------------------------------------------------------------ #
# repair_enabled toggle — sort integration                              #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_repair_enabled_false_skips_validation(tmp_path: Path) -> None:
    """With repair_enabled=False, validate_file must never be called; no _corrupted/ folder."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img_path = source / "photo.jpg"
    PIL_Image.new("RGB", (30, 30)).save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:04:01 10:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        repair_enabled=False,
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

    with patch.object(svc._repair, "validate_file") as mock_validate:
        stats = await svc.run(_FakeTask(), dry_run=False)

    # validate_file must never be called when repair_enabled=False
    mock_validate.assert_not_called()
    assert stats["sorted"] == 1
    corrupted_dir = target / "_corrupted"
    assert not corrupted_dir.exists()


@pytest.mark.asyncio
async def test_repair_enabled_true_quarantines_unrepairable_file(tmp_path: Path) -> None:
    """With repair_enabled=True, an unrepairable file lands in _corrupted/ with
    status='corrupted' and a non-empty error_message."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img_path = source / "photo.jpg"
    PIL_Image.new("RGB", (30, 30)).save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:04:01 10:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        repair_enabled=True,
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

    # Simulate: validate returns invalid; repair also fails → should quarantine
    with (
        patch.object(
            svc._repair,
            "validate_file",
            return_value=(False, "simulated corruption"),
        ),
        patch.object(svc._repair, "repair_file", return_value=False),
    ):
        stats = await svc.run(_FakeTask(), dry_run=False)

    assert stats["corrupted"] == 1
    assert stats["sorted"] == 0
    corrupted_dir = target / "_corrupted"
    assert corrupted_dir.exists()
    assert any(corrupted_dir.iterdir())


# ------------------------------------------------------------------ #
# New tests — PROMPT 5 additions                                       #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_run_failed_file_does_not_abort_batch(tmp_path: Path) -> None:
    """A file that raises mid-process is recorded as 'failed' with a non-empty
    error_message, and the run finishes all remaining files in the batch."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Two valid images
    for name, ts in [
        ("good.jpg", b"2024:06:01 10:00:00"),
        ("also_good.jpg", b"2024:06:02 10:00:00"),
    ]:
        p = source / name
        PIL_Image.new("RGB", (10, 10)).save(p, format="JPEG")
        piexif.insert(piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: ts}}), str(p))

    # One "bad" image (will cause extraction to raise)
    bad = source / "bad.jpg"
    bad.write_bytes(b"\xff\xd8\xff")

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year"],
        copy_instead_of_move=True,
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

    original_extract = svc._extraction.extract_detailed

    def side_effect(path, **kw):
        if path.name == "bad.jpg":
            raise RuntimeError("simulated extraction failure")
        return original_extract(path, **kw)

    with patch.object(svc._extraction, "extract_detailed", side_effect=side_effect):
        stats = await svc.run(_FakeTask(), dry_run=True)

    # All three files should have been processed (batch didn't abort)
    assert stats["total"] == 3
    assert stats["failed"] == 1, f"Expected 1 failed, got {stats['failed']}. Stats: {stats}"
    assert stats["sorted"] >= 1, (
        f"Expected at least 1 sorted, got {stats['sorted']}. Stats: {stats}"
    )


@pytest.mark.asyncio
async def test_run_persists_non_null_config_hash(tmp_path: Path, in_memory_db) -> None:
    """After a real (non-dry-run) sort, the operation row has a non-null config_hash."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    p = source / "photo.jpg"
    PIL_Image.new("RGB", (10, 10)).save(p, format="JPEG")
    piexif.insert(
        piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:01 00:00:00"}}),
        str(p),
    )

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year"],
        copy_instead_of_move=True,
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
        db_manager=in_memory_db,
    )

    await svc.run(_FakeTask(), dry_run=False)

    with in_memory_db._connect() as conn:
        row = conn.execute("SELECT config_hash FROM operations").fetchone()
    assert row is not None
    assert row["config_hash"] is not None
    assert len(row["config_hash"]) == 16  # 16-hex-char slice of SHA-256


@pytest.mark.asyncio
async def test_run_skipped_count_reflects_excluded_media_files(tmp_path: Path) -> None:
    """stats['skipped'] should equal the number of media files excluded by size filter."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Create one valid image that's large enough to pass the 1 KB filter.
    # A 200×200 JPEG with noise is typically 3-8 KB.
    import random as _random

    valid = source / "big.jpg"
    img = PIL_Image.new("RGB", (200, 200))
    pixels = [(int(_random.random() * 255),) * 3 for _ in range(200 * 200)]
    img.putdata(pixels)
    img.save(valid, format="JPEG", quality=95)
    piexif.insert(
        piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}),
        str(valid),
    )

    # Create two tiny (< 1 KB) media files that will be excluded by min_file_size_kb.
    (source / "tiny1.jpg").write_bytes(b"\xff\xd8\xff")
    (source / "tiny2.mp4").write_bytes(b"\x00\x00\x00")

    cfg = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year"],
        copy_instead_of_move=True,
        min_file_size_kb=1,  # tiny files (3 bytes) are below 1 KB; big.jpg is above
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

    stats = await svc.run(_FakeTask(), dry_run=True)

    # The two tiny files are excluded → skipped == 2
    assert stats["skipped"] == 2
    # Only the big valid image is processed
    assert stats["total"] == 1


def test_apply_rename_no_double_substitution(tmp_path: Path) -> None:
    """_apply_rename with a stem containing the literal 'TYPE' must not be re-substituted.

    Pattern: TYPE_YYYY-MM-DD_NAME, stem: TYPE_photo
    Expected: IMG_2024-03-15_TYPE_photo  (not IMG_2024-03-15_IMG_photo)
    """
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(tmp_path)
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir(parents=True)

    # Create a file whose stem contains "TYPE"
    img_path = dest_dir / "TYPE_photo.jpg"
    PIL_Image.new("RGB", (10, 10)).save(img_path, format="JPEG")

    cfg = Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "target"),
        sort_criteria=["year"],
        rename=True,
        rename_pattern="TYPE_YYYY-MM-DD_NAME",
    )

    result = svc._apply_rename(img_path, date(2024, 3, 15), cfg)

    # The NAME token expands to "TYPE_photo"; "TYPE" within that value must not
    # be substituted again (single-pass re.sub guarantees this).
    assert result.stem == "IMG_2024-03-15_TYPE_photo"
    # Must NOT be the double-substituted value
    assert "IMG_2024-03-15_IMG_photo" not in result.stem


# ------------------------------------------------------------------ #
# Copy mode: source files never touched for duplicates                 #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_copy_mode_duplicate_does_not_delete_source(tmp_path: Path) -> None:
    """In copy mode, a detected duplicate must leave the source file intact."""
    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    svc = _make_service(
        tmp_path,
        copy_instead_of_move=True,
        remove_duplicates=True,
    )
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "dup.jpg"
    img = PIL_Image.new("RGB", (50, 50), color=(200, 100, 50))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    with patch.object(
        svc._duplicates,
        "check_duplicate",
        return_value=DuplicateMatch(True, "exact", 100, "/orig/photo.jpg"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_copy_dup_test",
        )

    assert record["status"] == "duplicate"
    # Source file must still exist (copy mode never touches source)
    assert img_path.exists(), "Source file was deleted in copy mode — bug!"
    # Duplicate copy placed in _duplicates/ (not moved)
    assert record["dest_path"] is not None
    assert "_duplicates" in record["dest_path"]


# ------------------------------------------------------------------ #
# File timestamps are set to the extracted date                         #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_file_timestamps_set_to_extracted_date(tmp_path: Path) -> None:
    """After sorting, mtime of the destination file should match the extracted date."""

    PIL_Image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")

    svc = _make_service(tmp_path, copy_instead_of_move=True, remove_duplicates=False)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "photo.jpg"
    img = PIL_Image.new("RGB", (80, 80), color=(100, 150, 200))
    img.save(img_path, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2022:06:15 08:30:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_ts_test",
    )

    assert record["status"] == "success"
    dest = Path(record["dest_path"])
    assert dest.exists()

    dest_mtime = dest.stat().st_mtime
    # Expected: local midnight on 2022-06-15 (service uses naive datetime → local tz)
    from datetime import datetime as _dt

    expected_ts = _dt(2022, 6, 15).timestamp()
    assert abs(dest_mtime - expected_ts) < 2, (
        f"mtime {dest_mtime} should be close to extracted date timestamp {expected_ts}"
    )


# ------------------------------------------------------------------ #
# AI tagging integration                                               #
# ------------------------------------------------------------------ #


class _FakeAI:
    """Stand-in AITaggingService returning a fixed tag list."""

    def __init__(self, tags: list[str], raise_exc: bool = False) -> None:
        self._tags = tags
        self._raise = raise_exc
        self.calls: list[Path] = []

    def tag_file(self, path: Path) -> list[str]:
        self.calls.append(path)
        if self._raise:
            raise RuntimeError("tagger boom")
        return list(self._tags)


def _make_ai_service(tmp_path: Path, ai: Any, **overrides: Any) -> SortingService:
    cfg_kwargs: dict[str, Any] = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "target"),
        "sort_criteria": ["year", "month", "day"],
        "copy_instead_of_move": True,
        "recursive_scan": True,
        "remove_duplicates": False,
        "repair_enabled": False,
        "ai_tagging_enabled": True,
        "ai_tagging_embed_in_files": True,
    }
    cfg_kwargs.update(overrides)
    cfg = Config(**cfg_kwargs)
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
        ai_tagging_service=ai,
    )


def _dated_jpeg(path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")
    PIL_Image.new("RGB", (60, 60)).save(path, format="JPEG")
    piexif.insert(
        piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2023:05:01 09:00:00"}}),
        str(path),
    )


@pytest.mark.asyncio
async def test_process_file_merges_and_embeds_ai_tags(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    ai = _FakeAI(["beach", "sunset"])
    svc = _make_ai_service(tmp_path, ai)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "vac.jpg"
    _dated_jpeg(img_path)

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_ai",
    )

    assert record["status"] == "success"
    assert record["tags"] == ["beach", "sunset"]
    assert ai.calls, "AI tagger should have been invoked on the placed file"

    # Tags were embedded into the destination JPEG (XPKeywords).
    dest = Path(record["dest_path"])
    xp = bytes(piexif.load(str(dest))["0th"][piexif.ImageIFD.XPKeywords])
    assert xp.decode("utf-16le").rstrip("\x00") == "beach;sunset"


@pytest.mark.asyncio
async def test_process_file_ai_failure_does_not_abort(tmp_path: Path) -> None:
    """A tagger that raises must not fail the file — it still sorts."""
    svc = _make_ai_service(tmp_path, _FakeAI([], raise_exc=True))
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "ok.jpg"
    _dated_jpeg(img_path)

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_ai_err",
    )

    assert record["status"] == "success"
    assert Path(record["dest_path"]).exists()


@pytest.mark.asyncio
async def test_process_file_ai_disabled_skips_tagger(tmp_path: Path) -> None:
    ai = _FakeAI(["beach"])
    svc = _make_ai_service(tmp_path, ai, ai_tagging_enabled=False)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "plain.jpg"
    _dated_jpeg(img_path)

    record = svc._process_file(
        file_path=img_path,
        source_root=source_root,
        dest_root=dest_root,
        config=svc._config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_ai_off",
    )

    assert record["status"] == "success"
    assert ai.calls == []  # tagger never called when disabled
    assert record["tags"] == []


# ------------------------------------------------------------------ #
# Copy-mode invariant: the source is NEVER moved or deleted            #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_copy_mode_unknown_date_keeps_source(tmp_path: Path) -> None:
    """Copy mode: an unknown-date file is COPIED to _unknown_dates/, source kept."""
    svc = _make_service(tmp_path, copy_instead_of_move=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "nodate.jpg"
    img_path.write_bytes(b"\xff\xd8\xff" + b"x" * 64)

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=None, source="none"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "unknown_date"
    assert img_path.exists(), "copy mode must never consume the source"
    assert (dest_root / "_unknown_dates" / "nodate.jpg").exists()


@pytest.mark.asyncio
async def test_copy_mode_future_date_keeps_source(tmp_path: Path) -> None:
    """Copy mode: a future-date file is COPIED to _future_dates/, source kept."""
    from datetime import timedelta

    svc = _make_service(tmp_path, copy_instead_of_move=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "future.jpg"
    img_path.write_bytes(b"\xff\xd8\xff" + b"x" * 64)

    future = date.today() + timedelta(days=30)
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=future, source="exif"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "future_date"
    assert img_path.exists(), "copy mode must never consume the source"
    assert (dest_root / "_future_dates" / "future.jpg").exists()


@pytest.mark.asyncio
async def test_copy_mode_processing_failure_keeps_source(tmp_path: Path) -> None:
    """Copy mode: a file that fails processing is COPIED to _failed/, source kept."""
    svc = _make_service(tmp_path, copy_instead_of_move=True)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "explodes.jpg"
    img_path.write_bytes(b"\xff\xd8\xff" + b"x" * 64)

    with patch.object(svc._extraction, "extract_detailed", side_effect=RuntimeError("boom")):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "failed"
    assert record["error_message"] == "boom"
    assert img_path.exists(), "copy mode must never consume the source, even on failure"
    assert (dest_root / "_failed" / "explodes.jpg").exists()


@pytest.mark.asyncio
async def test_move_mode_unknown_date_consumes_source(tmp_path: Path) -> None:
    """Move mode keeps the original behaviour: the source is moved away."""
    svc = _make_service(tmp_path, copy_instead_of_move=False)
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    img_path = source_root / "nodate.jpg"
    img_path.write_bytes(b"\xff\xd8\xff" + b"x" * 64)

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=None, source="none"),
    ):
        record = svc._process_file(
            file_path=img_path,
            source_root=source_root,
            dest_root=dest_root,
            config=svc._config,
            dry_run=False,
            registry=DuplicateRegistry(),
            operation_id="op_test",
        )

    assert record["status"] == "unknown_date"
    assert not img_path.exists()
    assert (dest_root / "_unknown_dates" / "nodate.jpg").exists()


# ------------------------------------------------------------------ #
# Dry-run purity: no directories are created on the destination volume #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_dry_run_creates_no_directories(tmp_path: Path) -> None:
    """A dry run must not mkdir anything under the destination root."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    svc = _make_service(
        tmp_path,
        copy_instead_of_move=True,
        categorize_enabled=False,
        camera_subfolder_enabled=False,
    )
    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir(parents=True)
    dest_root.mkdir(parents=True)

    # One file with a valid EXIF date and one with no date at all, so both the
    # normal destination path and the quarantine path are exercised.
    img_path = source_root / "photo.jpg"
    img = PIL_Image.new("RGB", (40, 40))
    img.save(img_path, format="JPEG")
    exif = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2023:05:17 10:00:00"}}
    piexif.insert(piexif.dump(exif), str(img_path))
    (source_root / "nodate.bin.jpg").write_bytes(b"\xff\xd8\xff" + b"x" * 64)

    task = _FakeTask()
    stats = await svc.run(task, dry_run=True)

    assert stats["total"] == 2
    leftovers = list(dest_root.rglob("*"))
    assert leftovers == [], f"dry run created entries under dest: {leftovers}"
    assert (source_root / "photo.jpg").exists()
