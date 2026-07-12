"""Tests for PreviewService — dry-run scan."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import Config
from app.services.extraction_service import DateExtractionService, ExtractionResult
from app.services.filesystem_service import FileSystemService
from app.services.preview_service import PreviewService
from app.services.rule_engine_service import RuleEngineService


def _make_preview_service(config: Config) -> PreviewService:
    from app.services.duplicate_service import DuplicateService

    return PreviewService(
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        rule_engine_service=RuleEngineService(config=config),
        duplicate_service=DuplicateService(),
    )


def _make_config(source: Path, target: Path, **overrides: object) -> Config:
    return Config(
        source_directory=str(source),
        target_directory=str(target),
        sort=True,
        sort_criteria=["year", "month", "day"],
        recursive_scan=True,
        **overrides,  # type: ignore[arg-type]
    )


# ------------------------------------------------------------------ #
# Preview does NOT modify files                                         #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_does_not_modify_source(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img = source / "test.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:15 10:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    original_content = img.read_bytes()
    original_files = list(source.iterdir())

    cfg = _make_config(source, target)
    await _make_preview_service(cfg).preview(cfg)

    # Source unchanged
    assert img.read_bytes() == original_content
    assert list(source.iterdir()) == original_files
    # Target untouched
    assert list(target.iterdir()) == []


@pytest.mark.asyncio
async def test_preview_keeps_higher_resolution_duplicate_regardless_of_order(
    tmp_path: Path,
) -> None:
    """Preview mirrors the sort: the higher-resolution copy is predicted as the
    kept original and the lower-resolution copy as the duplicate, independent of
    filename order — and items stay in their original (list_files) order."""
    pytest.importorskip("imagehash")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Solid grey → identical phash; different resolutions. "a_low" sorts first.
    low = source / "a_low.jpg"
    high = source / "b_high.jpg"
    PIL_Image.new("RGB", (64, 64), color=(120, 120, 120)).save(low, format="JPEG", quality=95)
    PIL_Image.new("RGB", (256, 256), color=(120, 120, 120)).save(high, format="JPEG", quality=95)

    cfg = _make_config(
        source,
        target,
        remove_duplicates=True,
        duplicate_exact_enabled=False,  # different bytes → exercise the perceptual path
        duplicate_perceptual_enabled=True,
        duplicate_perceptual_threshold=90,
    )
    svc = _make_preview_service(cfg)

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
    ):
        result = await svc.preview(cfg)

    by_name = {Path(it["source"]).name: it for it in result["items"]}
    # Output order is preserved (alphabetical from list_files), despite quality-
    # ordered processing under the hood.
    assert [Path(it["source"]).name for it in result["items"]] == ["a_low.jpg", "b_high.jpg"]
    assert by_name["b_high.jpg"]["status"] == "sort"
    assert by_name["a_low.jpg"]["status"] == "duplicate"
    assert by_name["a_low.jpg"]["duplicate_of"] == str(high)
    assert result["stats"]["will_sort"] == 1
    assert result["stats"]["will_skip_duplicate"] == 1


@pytest.mark.asyncio
async def test_preview_destination_empty_after_run(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    for name, ts in [("a.jpg", b"2024:03:10 12:00:00"), ("b.jpg", b"2023:07:04 08:00:00")]:
        p = source / name
        PIL_Image.new("RGB", (50, 50)).save(p, format="JPEG")
        exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: ts}}
        piexif.insert(piexif.dump(exif_dict), str(p))

    cfg = _make_config(source, target)
    await _make_preview_service(cfg).preview(cfg)

    assert list(target.rglob("*")) == []


# ------------------------------------------------------------------ #
# Stats                                                                  #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_stats_counts_sortable_files(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # 2 files with EXIF dates — use distinct colors to avoid duplicate-hash collision
    colors_and_dates = [
        ((200, 100, 50), b"2024:01:15 10:00:00", "a.jpg"),
        ((50, 150, 200), b"2023:06:01 08:00:00", "b.jpg"),
    ]
    for color, ts, name in colors_and_dates:
        p = source / name
        PIL_Image.new("RGB", (50, 50), color=color).save(p, format="JPEG")
        exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: ts}}
        piexif.insert(piexif.dump(exif_dict), str(p))

    # Disable duplicate detection so both files are counted as will_sort
    cfg = _make_config(source, target, remove_duplicates=False)
    result = await _make_preview_service(cfg).preview(cfg)

    assert result["stats"]["total"] == 2
    assert result["stats"]["will_sort"] == 2
    assert result["stats"]["will_fail"] == 0


@pytest.mark.asyncio
async def test_preview_stats_counts_undatable_files(tmp_path: Path) -> None:
    from unittest.mock import patch

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    # Create 3 fake JPEG files
    for i in range(3):
        (source / f"photo_{i}.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target)
    svc = _make_preview_service(cfg)

    # Force extraction to return None for all files
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=None, source="none"),
    ):
        result = await svc.preview(cfg)

    assert result["stats"]["total"] == 3
    assert result["stats"]["will_sort"] == 0
    # Files with no date go to will_quarantine_unknown (not will_fail)
    assert result["stats"]["will_quarantine_unknown"] == 3
    assert result["stats"]["will_fail"] == 0


# ------------------------------------------------------------------ #
# Items                                                                  #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_items_include_destination_path(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img = source / "pic.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    cfg = _make_config(source, target)
    result = await _make_preview_service(cfg).preview(cfg)

    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["source"] == str(img)
    assert "2024" in item["destination"]
    assert "03" in item["destination"]
    assert "10" in item["destination"]
    assert item["extracted_date"] == "2024-03-10"
    assert item["metadata_source"] == "exif"


@pytest.mark.asyncio
async def test_preview_empty_source_returns_no_items(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    cfg = _make_config(source, target)
    result = await _make_preview_service(cfg).preview(cfg)

    assert result["items"] == []
    assert result["stats"]["total"] == 0


# ------------------------------------------------------------------ #
# Tags from RuleEngine                                                   #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_includes_tags(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img = source / "video_clip.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    cfg = _make_config(
        source,
        target,
        rules_enabled=True,
        rules=[
            {
                "id": "rule_1",
                "name": "Contains video",
                "enabled": True,
                "condition": {"type": "filename_contains", "value": "video"},
                "tag": "VIDEO_CLIP",
            }
        ],
    )
    result = await _make_preview_service(cfg).preview(cfg)

    assert len(result["items"]) == 1
    assert "VIDEO_CLIP" in result["items"][0]["tags"]


# ------------------------------------------------------------------ #
# Fix 5 regression: complete stats and status field                    #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_item_has_status_field(tmp_path: Path) -> None:
    """Every preview item must include a 'status' field."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    img = source / "photo.jpg"
    PIL_Image.new("RGB", (50, 50)).save(img, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img))

    cfg = _make_config(source, target)
    result = await _make_preview_service(cfg).preview(cfg)

    assert len(result["items"]) == 1
    assert result["items"][0]["status"] == "sort"


@pytest.mark.asyncio
async def test_preview_stats_counts_future_dates(tmp_path: Path) -> None:
    """Files with a future date go to will_quarantine_future."""
    from datetime import timedelta
    from unittest.mock import patch

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    (source / "future.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target)
    svc = _make_preview_service(cfg)

    future_date = date.today() + timedelta(days=30)
    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=future_date, source="exif"),
    ):
        result = await svc.preview(cfg)

    assert result["stats"]["will_quarantine_future"] == 1
    assert result["stats"]["will_sort"] == 0
    assert result["items"][0]["status"] == "future_date"


@pytest.mark.asyncio
async def test_preview_stats_all_fields_present(tmp_path: Path) -> None:
    """Stats dict must contain all five classification fields."""
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()

    cfg = _make_config(source, target)
    result = await _make_preview_service(cfg).preview(cfg)

    for key in (
        "total",
        "will_sort",
        "will_fail",
        "will_quarantine_unknown",
        "will_quarantine_future",
        "will_skip_duplicate",
        "uncategorized",
    ):
        assert key in result["stats"], f"Missing stat key: {key}"


# ------------------------------------------------------------------ #
# Smart Categorization parity                                           #
# ------------------------------------------------------------------ #


class _FakePreviewClassifier:
    def __init__(self, category: str | None) -> None:
        self._category = category

    def classify_file(self, path: Path) -> object:
        from app.services.ai.category_classifier_service import CategoryResult

        return CategoryResult(self._category, 0.99, 0.9)


@pytest.mark.asyncio
async def test_preview_item_and_path_carry_category(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / "p.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target, remove_duplicates=False, categorize_enabled=True)
    svc = _make_preview_service(cfg)
    svc._classifier = _FakePreviewClassifier("nature")

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 3, 10), source="exif"),
    ):
        result = await svc.preview(cfg)

    item = result["items"][0]
    assert item["category"] == "nature"
    assert "nature" in item["destination"]
    assert result["stats"]["uncategorized"] == 0


@pytest.mark.asyncio
async def test_preview_counts_uncategorized(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / "p.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target, remove_duplicates=False, categorize_enabled=True)
    svc = _make_preview_service(cfg)
    svc._classifier = _FakePreviewClassifier(None)  # below confidence bar

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 3, 10), source="exif"),
    ):
        result = await svc.preview(cfg)

    item = result["items"][0]
    assert item["category"] is None
    assert "_uncategorized" in item["destination"]
    assert result["stats"]["uncategorized"] == 1


@pytest.mark.asyncio
async def test_preview_path_matches_sort_path_for_category(tmp_path: Path) -> None:
    """The preview's predicted path must equal SortingService's real placement."""
    from app.services.sorting_service import SortingService

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    file_path = source / "p.jpg"
    file_path.write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target, categorize_enabled=True)
    _, predicted = _make_preview_service(cfg)._build_dest_path(
        file_path, date(2024, 3, 10), source, target, cfg, "food"
    )

    svc = SortingService.__new__(SortingService)
    svc._fs = FileSystemService()
    svc._extraction = DateExtractionService()
    real = svc._build_dest(file_path, date(2024, 3, 10), source, target, cfg, "food")

    assert Path(predicted) == real


# ------------------------------------------------------------------ #
# Progress reporting via a task (drives the determinate progress bar)  #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_preview_reports_progress_on_task(tmp_path: Path) -> None:
    """When a task is supplied, preview fills in current/total/percentage."""
    from unittest.mock import patch

    from app.background_tasks.task_manager import Task

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    for i in range(3):
        (source / f"p_{i}.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target, remove_duplicates=False)
    svc = _make_preview_service(cfg)
    task = Task(id="preview-test")

    with patch.object(
        svc._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 3, 10), source="exif"),
    ):
        result = await svc.preview(cfg, task=task)

    assert task.progress.total == 3
    assert task.progress.current == 3
    assert task.progress.percentage == 100.0
    assert len(result["items"]) == 3


@pytest.mark.asyncio
async def test_preview_reports_phases(tmp_path: Path) -> None:
    """With perceptual de-dup on, the task advances ranking → previewing → 100%."""
    from unittest.mock import patch

    from app.background_tasks.task_manager import Task

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    for i in range(3):
        (source / f"p_{i}.jpg").write_bytes(b"\xff\xd8\xff")

    # Perceptual de-dup on → there is a "ranking" pre-pass before "previewing".
    cfg = _make_config(
        source, target, duplicate_exact_enabled=False, duplicate_perceptual_enabled=True
    )
    svc = _make_preview_service(cfg)
    task = Task(id="phase-test")

    # Snapshot the phase at each ranking (quality_key) and per-file step.
    seen: list[str | None] = []
    orig_quality_key = svc._dups.quality_key  # type: ignore[union-attr]
    orig_preview_file = svc._preview_file

    def spy_quality_key(p: Path) -> tuple[int, int]:
        seen.append(task.progress.phase)
        return orig_quality_key(p)

    def spy_preview_file(*args: object, **kwargs: object) -> dict[str, object]:
        seen.append(task.progress.phase)
        return orig_preview_file(*args, **kwargs)  # type: ignore[arg-type]

    with (
        patch.object(svc._dups, "quality_key", side_effect=spy_quality_key),
        patch.object(svc, "_preview_file", side_effect=spy_preview_file),
        patch.object(
            svc._extraction,
            "extract_detailed",
            return_value=ExtractionResult(extracted_date=date(2024, 3, 10), source="exif"),
        ),
    ):
        result = await svc.preview(cfg, task=task)

    assert "ranking" in seen and "previewing" in seen
    # The whole ranking pass precedes the first per-file prediction.
    assert seen.index("ranking") < seen.index("previewing")
    assert task.progress.phase == "previewing"
    assert task.progress.percentage == 100.0
    assert len(result["items"]) == 3


@pytest.mark.asyncio
async def test_preview_honors_cancellation(tmp_path: Path) -> None:
    """A task cancelled before processing stops immediately with no items."""
    from app.background_tasks.task_manager import Task

    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    for i in range(3):
        (source / f"p_{i}.jpg").write_bytes(b"\xff\xd8\xff")

    cfg = _make_config(source, target)
    svc = _make_preview_service(cfg)
    task = Task(id="preview-cancel")
    task.cancel()  # cancel before the loop starts

    result = await svc.preview(cfg, task=task)

    assert result["items"] == []
    assert task.progress.total == 3  # total is set before the loop runs
