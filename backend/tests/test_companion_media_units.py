"""Companion fixtures exercise binding, catalog refresh, and unit-safe planning."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from time import monotonic
from typing import Any
from unittest.mock import Mock, patch

import pytest
from PIL import Image

from app.background_tasks.task_manager import CancellationToken
from app.core.config import Config, ConfigLoader
from app.core.integrity import PreservationProfile
from app.core.media_units import bind_media_units
from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.destination import companion_destination
from app.services.discovery import DiscoveryStats, TraversalRules, discover_into_catalog, walk
from app.services.duplicate_service import DuplicateMatch, DuplicateRegistry, DuplicateService
from app.services.extraction_service import ExtractionResult
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.mutation_planner import build_placement_action
from app.services.preview_service import PreviewService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService


def _companion_library(root: Path) -> Path:
    fixtures = {
        "photo.jpg": b"jpeg",
        "photo.xmp": b"xmp",
        "photo.aae": b"aae",
        "live.heic": b"heic",
        "live.mov": b"mov",
        "capture.dng": b"raw",
        "capture.jpeg": b"jpeg",
        "clip.mp4": b"video",
        "clip.thm": b"thumb",
        "README.jpg": b"image",
        "README.txt": b"unrelated",
        "IMG.JPG": b"image",
        "img.xmp": b"case",
        "primary/lonely.jpg": b"image",
        "elsewhere/lonely.xmp": b"unmatched",
    }
    for relative, content in fixtures.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return root


def test_fixture_matrix_binds_typed_units_without_changing_eligible_total(
    tmp_path: Path,
) -> None:
    root = _companion_library(tmp_path / "library")
    paths = [path for path in root.rglob("*") if path.is_file()]

    units, unmatched = bind_media_units(paths, root)

    # Nine files were eligible media before companion support and still are.
    eligible = [path for path in paths if path.suffix.lower() in FileSystemService.MEDIA_EXTENSIONS]
    assert len(eligible) == 9
    assert len(units) == 7
    assert sum(len(unit.companions) for unit in units) == 6
    roles = {member.companion_role for unit in units for member in unit.companions}
    assert roles == {
        "edit_sidecar",
        "motion_part",
        "raw_sibling",
        "thumbnail_part",
    }
    assert [(item.path.name, item.reason) for item in unmatched] == [
        ("lonely.xmp", "no_primary_in_same_directory")
    ]


def test_primary_precedence_and_pairing_preconditions_are_conservative(tmp_path: Path) -> None:
    root = _companion_library(tmp_path / "library")
    units, _ = bind_media_units([path for path in root.rglob("*") if path.is_file()], root)
    by_stem = {unit.primary.stem.casefold(): unit for unit in units}

    assert by_stem["capture"].primary.suffix == ".dng"
    assert by_stem["live"].primary.suffix == ".heic"
    assert by_stem["readme"].companions == ()
    assert {member.path.suffix for member in by_stem["photo"].companions} == {".xmp", ".aae"}


def test_historical_raw_jpeg_independent_comparison_measures_default_match(
    tmp_path: Path,
) -> None:
    """Record why primary-only comparison is necessary: distance 0, similarity 100."""
    raw = tmp_path / "capture.dng"
    jpeg = tmp_path / "capture.jpeg"
    raw.write_bytes(b"raw container")
    jpeg.write_bytes(b"jpeg container")
    duplicates = DuplicateService()
    registry = DuplicateRegistry()

    def decoded(_path: Path) -> Image.Image:
        return Image.new("RGB", (64, 64), (90, 120, 160))

    with patch("app.services.duplicate_service.open_image", side_effect=decoded):
        first = duplicates.check_duplicate(raw, registry, exact=False, perceptual=True)
        second = duplicates.check_duplicate(
            jpeg,
            registry,
            exact=False,
            perceptual=True,
            threshold=95,
        )

    assert first.is_duplicate is False
    assert second.is_duplicate is True
    assert second.match_type == "perceptual"
    assert second.similarity == 100  # 256-bit pHash Hamming distance = 0


def test_ignore_exactly_reproduces_eligible_media_only_behavior(tmp_path: Path) -> None:
    root = _companion_library(tmp_path / "library")
    paths = [path for path in root.rglob("*") if path.is_file()]
    before = {path.relative_to(root): path.read_bytes() for path in paths}

    units, unmatched = bind_media_units(paths, root, handling="ignore")

    assert [unit.primary for unit in units] == sorted(
        path for path in paths if path.suffix.lower() in FileSystemService.MEDIA_EXTENSIONS
    )
    assert all(not unit.companions for unit in units)
    assert unmatched == []
    assert {path.relative_to(root): path.read_bytes() for path in paths} == before


def test_stem_matching_can_model_case_insensitive_and_case_sensitive_volumes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "library"
    root.mkdir()
    image = root / "IMG.JPG"
    sidecar = root / "img.xmp"
    image.write_bytes(b"image")
    sidecar.write_bytes(b"xmp")

    insensitive, _ = bind_media_units([image, sidecar], root, case_sensitive=False)
    sensitive, unmatched = bind_media_units([image, sidecar], root, case_sensitive=True)

    assert [member.path for member in insensitive[0].companions] == [sidecar]
    assert sensitive[0].companions == ()
    assert [item.path for item in unmatched] == [sidecar]


def test_companion_in_another_directory_is_never_bound(tmp_path: Path) -> None:
    root = tmp_path / "library"
    primary = root / "one" / "same.jpg"
    sidecar = root / "two" / "same.xmp"
    primary.parent.mkdir(parents=True)
    sidecar.parent.mkdir(parents=True)
    primary.write_bytes(b"image")
    sidecar.write_bytes(b"xmp")

    units, unmatched = bind_media_units([primary, sidecar], root)

    assert units[0].companions == ()
    assert [item.path for item in unmatched] == [sidecar]


def test_collision_suffix_and_renamed_stem_are_inherited_by_every_member() -> None:
    primary = Path("/target/2024/IMG_2024-07-01_001.jpg")

    assert companion_destination(primary, Path("/source/IMG.xmp")) == Path(
        "/target/2024/IMG_2024-07-01_001.xmp"
    )
    assert companion_destination(primary, Path("/source/IMG.mov")) == Path(
        "/target/2024/IMG_2024-07-01_001.mov"
    )


@pytest.mark.asyncio
async def test_filesystem_scan_reports_companions_separately(tmp_path: Path) -> None:
    root = _companion_library(tmp_path / "library")

    result = await FileSystemService().traverse(root)

    assert len(result.files) == 9
    assert sum(len(unit.companions) for unit in result.units) == 6
    assert len(result.unmatched_companions) == 1


def test_streaming_discovery_persists_units_and_refreshes_companion_changes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "library"
    root.mkdir()
    (root / "photo.jpg").write_bytes(b"image")
    with MediaCatalog(tmp_path / "catalog.db") as catalog:
        catalog.register_root("root", root)
        discover_into_catalog(catalog, "root", root)
        assert len(next(catalog.iter_units("root")).members) == 1

        (root / "photo.xmp").write_bytes(b"xmp")
        discover_into_catalog(catalog, "root", root)
        assert [member.companion_role for member in next(catalog.iter_units("root")).members] == [
            None,
            "edit_sidecar",
        ]

        (root / "photo.xmp").rename(root / "photo.aae")
        discover_into_catalog(catalog, "root", root)
        assert {member.relative_path for member in next(catalog.iter_units("root")).members} == {
            "photo.jpg",
            "photo.aae",
        }

        (root / "photo.aae").unlink()
        discover_into_catalog(catalog, "root", root)
        assert len(next(catalog.iter_units("root")).members) == 1
        # Existing per-file callers retain their cursor API throughout.
        assert [item.relative_path for item in catalog.iter_files("root")] == ["photo.jpg"]


def test_catalog_duplicate_groups_can_never_offer_a_companion_as_keeper(
    tmp_path: Path,
) -> None:
    with MediaCatalog(tmp_path / "catalog.db") as catalog:
        catalog.register_root("root", tmp_path, role="input")
        generation = catalog.begin_generation("root")
        records = catalog.observe(
            "root",
            generation,
            [
                ObservedFile(
                    "a.jpg",
                    10,
                    1,
                    unit_id="unit_a",
                    unit_primary=True,
                    primary_relative_path="a.jpg",
                ),
                ObservedFile(
                    "a.xmp",
                    5,
                    1,
                    unit_id="unit_a",
                    companion_role="edit_sidecar",
                    primary_relative_path="a.jpg",
                ),
                ObservedFile(
                    "b.jpg",
                    10,
                    1,
                    unit_id="unit_b",
                    unit_primary=True,
                    primary_relative_path="b.jpg",
                ),
            ],
        )
        catalog.finish_generation(generation, "complete")
        for record in records:
            catalog.store_hash(record, "a" * 64)

        groups = list(CatalogDuplicateIndex(catalog).iter_exact_groups())

    assert len(groups) == 1
    assert [candidate.record.relative_path for candidate in groups[0][1]] == [
        "a.jpg",
        "b.jpg",
    ]
    assert all(candidate.record.unit_primary for candidate in groups[0][1])


def test_discovery_stats_keep_generic_and_eligible_counts_distinct(tmp_path: Path) -> None:
    root = _companion_library(tmp_path / "library")
    stats = DiscoveryStats()

    list(walk(root, TraversalRules(), stats))

    assert stats.files == 15
    assert stats.eligible_media == 9
    assert stats.companions == 6
    assert len(stats.unmatched_companions) == 1


def test_companion_handling_environment_override_is_typed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEDIASORT_COMPANION_HANDLING", "leave_in_place")

    config = ConfigLoader()._apply_env_overrides(Config())

    assert config.companion_handling == "leave_in_place"


class _DivergentDates:
    def extract_detailed(self, path: Path, *, check_suspicious: bool = False) -> ExtractionResult:
        del check_suspicious
        return ExtractionResult(
            (date(2030, 2, 2) if path.suffix.lower() in {".xmp", ".jpeg"} else date(2020, 1, 1)),
            "filesystem",
        )

    def extract_camera_model(self, _path: Path) -> None:
        return None


def _sorting_service(tmp_path: Path, duplicate_service: object) -> SortingService:
    config = Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "target"),
        copy_instead_of_move=True,
        remove_duplicates=True,
        duplicate_perceptual_enabled=True,
        sort_criteria=["year"],
    )
    return SortingService(
        config,
        ConfigService(config),
        FileSystemService(),
        _DivergentDates(),  # type: ignore[arg-type]
        duplicate_service,  # type: ignore[arg-type]
        MetadataService(),
        ConversionService(),
        RepairService(),
        None,
    )


@pytest.mark.parametrize("threshold", [0, 95, 100])
def test_unit_uses_only_primary_for_date_and_duplicate_placement(
    tmp_path: Path, threshold: int
) -> None:
    root = tmp_path / "source"
    root.mkdir()
    raw = root / "capture.dng"
    jpeg = root / "capture.jpeg"
    raw.write_bytes(b"raw")
    jpeg.write_bytes(b"jpeg")
    unit = bind_media_units([raw, jpeg], root)[0][0]
    duplicates = Mock()
    duplicates.check_duplicate.return_value = DuplicateMatch(False)
    service = _sorting_service(tmp_path, duplicates)
    config = service._config
    config.duplicate_perceptual_threshold = threshold

    records = service._process_unit(
        unit=unit,
        source_root=root,
        dest_root=tmp_path / "target",
        config=config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op",
        dest_registry=None,
        reserved_destinations=set(),
        operation_rules=None,
        operation_ai=None,
        operation_classifier=None,
        use_operation_services=False,
        cancel_signal=CancellationToken(),
        execution=None,
    )

    assert duplicates.check_duplicate.call_count == 1
    assert duplicates.check_duplicate.call_args.args[0] == raw
    assert Path(records[0]["dest_path"]).parent.name == "2020"
    assert Path(records[1]["dest_path"]).parent.name == "2020"
    assert records[1]["extracted_date"] == "2030-02-02"
    assert records[1]["metadata_source"] == "report_only"


def test_leave_in_place_is_reported_before_commit_and_transfers_nothing(
    tmp_path: Path,
) -> None:
    root = tmp_path / "source"
    root.mkdir()
    image = root / "photo.jpg"
    xmp = root / "photo.xmp"
    image.write_bytes(b"image")
    xmp.write_bytes(b"xmp")
    unit = bind_media_units([image, xmp], root)[0][0]
    duplicates = Mock()
    duplicates.check_duplicate.return_value = DuplicateMatch(False)
    service = _sorting_service(tmp_path, duplicates)
    config = service._config
    config.companion_handling = "leave_in_place"

    records = service._process_unit(
        unit=unit,
        source_root=root,
        dest_root=tmp_path / "target",
        config=config,
        dry_run=True,
        registry=DuplicateRegistry(),
        operation_id="op",
        dest_registry=None,
        reserved_destinations=set(),
        operation_rules=None,
        operation_ai=None,
        operation_classifier=None,
        use_operation_services=False,
        cancel_signal=CancellationToken(),
        execution=None,
    )

    assert records[1]["status"] == "companion_left_in_place"
    assert records[1]["dest_path"] is None
    assert xmp.read_bytes() == b"xmp"


def test_every_fixture_companion_inherits_its_primary_destination(tmp_path: Path) -> None:
    root = _companion_library(tmp_path / "source")
    paths = [path for path in root.rglob("*") if path.is_file()]
    units, _ = bind_media_units(paths, root)
    service = _sorting_service(tmp_path, Mock())
    config = service._config
    config.remove_duplicates = False
    reserved: set[Path] = set()

    for unit in units:
        records = service._process_unit(
            unit=unit,
            source_root=root,
            dest_root=tmp_path / "target",
            config=config,
            dry_run=True,
            registry=DuplicateRegistry(),
            operation_id="op",
            dest_registry=None,
            reserved_destinations=reserved,
            operation_rules=None,
            operation_ai=None,
            operation_classifier=None,
            use_operation_services=False,
            cancel_signal=CancellationToken(),
            execution=None,
        )
        primary_destination = Path(records[0]["dest_path"])
        for companion in records[1:]:
            destination = Path(companion["dest_path"])
            assert destination.parent == primary_destination.parent
            assert destination.stem == primary_destination.stem


@pytest.mark.asyncio
async def test_preview_attaches_roles_and_reports_split_and_unmatched_totals(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / "photo.jpg").write_bytes(b"image")
    (source / "photo.xmp").write_bytes(b"xmp")
    (source / "orphan.xmp").write_bytes(b"orphan")
    config = Config(
        source_directory=str(source),
        target_directory=str(target),
        remove_duplicates=False,
        companion_handling="leave_in_place",
        sort_criteria=["year"],
    )
    preview = PreviewService(
        FileSystemService(),
        _DivergentDates(),  # type: ignore[arg-type]
        None,
    )

    result = await preview.preview(config)

    assert result["stats"]["eligible_media"] == 1
    assert result["stats"]["companions"] == 1
    assert result["stats"]["companion_split_warnings"] == 1
    assert result["stats"]["unmatched_companions"] == 1
    assert result["items"][0]["companions"][0]["role"] == "edit_sidecar"
    assert result["items"][0]["companions"][0]["status"] == "left_in_place"
    assert result["unmatched_companions"][0]["source"].endswith("orphan.xmp")


def test_move_commits_primary_first_and_retains_a_failing_companion_source(
    tmp_path: Path,
) -> None:
    root = tmp_path / "source"
    root.mkdir()
    image = root / "photo.jpg"
    xmp = root / "photo.xmp"
    image.write_bytes(b"image")
    xmp.write_bytes(b"xmp")
    unit = bind_media_units([image, xmp], root)[0][0]
    service = _sorting_service(tmp_path, Mock())
    config = service._config
    config.copy_instead_of_move = False
    config.remove_duplicates = False
    target = tmp_path / "target"
    original_move = service._fs.safe_move

    def fail_companion(source: Path, destination: Path) -> Any:
        if source.suffix.lower() == ".xmp":
            raise OSError("simulated companion verification failure")
        return original_move(source, destination)

    service._fs.safe_move = Mock(side_effect=fail_companion)
    records = service._process_unit(
        unit=unit,
        source_root=root,
        dest_root=target,
        config=config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op",
        dest_registry=None,
        reserved_destinations=set(),
        operation_rules=None,
        operation_ai=None,
        operation_classifier=None,
        use_operation_services=False,
        cancel_signal=CancellationToken(),
        execution=None,
    )

    assert records[0]["status"] == "success"
    assert Path(records[0]["dest_path"]).read_bytes() == b"image"
    assert records[1]["status"] == "incomplete_unit"
    assert xmp.read_bytes() == b"xmp"
    assert not image.exists()


def test_duplicate_evaluation_quarantines_a_whole_different_unit(tmp_path: Path) -> None:
    root = tmp_path / "source"
    root.mkdir()
    paths = []
    for stem in ("a", "b"):
        image = root / f"{stem}.jpg"
        sidecar = root / f"{stem}.xmp"
        image.write_bytes(b"identical primary bytes")
        sidecar.write_bytes(f"{stem} edit".encode())
        paths.extend((image, sidecar))
    units, _ = bind_media_units(paths, root)
    service = _sorting_service(tmp_path, DuplicateService())
    config = service._config
    config.copy_instead_of_move = False
    config.duplicate_perceptual_enabled = False
    target = tmp_path / "target"
    registry = DuplicateRegistry()

    first = service._process_unit(
        unit=units[0],
        source_root=root,
        dest_root=target,
        config=config,
        dry_run=False,
        registry=registry,
        operation_id="op",
        dest_registry=None,
        reserved_destinations=set(),
        operation_rules=None,
        operation_ai=None,
        operation_classifier=None,
        use_operation_services=False,
        cancel_signal=CancellationToken(),
        execution=None,
    )
    second = service._process_unit(
        unit=units[1],
        source_root=root,
        dest_root=target,
        config=config,
        dry_run=False,
        registry=registry,
        operation_id="op",
        dest_registry=None,
        reserved_destinations=set(),
        operation_rules=None,
        operation_ai=None,
        operation_classifier=None,
        use_operation_services=False,
        cancel_signal=CancellationToken(),
        execution=None,
    )

    assert {Path(item["dest_path"]).parent for item in first} == {target / "2020"}
    assert second[0]["status"] == "duplicate"
    assert {Path(item["dest_path"]).parent for item in second} == {target / "_duplicates"}


def test_manifest_actions_carry_unit_identity_and_primary_reference(tmp_path: Path) -> None:
    source = tmp_path / "photo.xmp"
    source.write_bytes(b"xmp")

    action = build_placement_action(
        source,
        tmp_path / "target" / "photo.xmp",
        kind="move",
        move=True,
        preservation=PreservationProfile(),
        root_id="root",
        relative_path="photo.xmp",
        unit_id="unit_123",
        companion_role="edit_sidecar",
        unit_primary_path=str(tmp_path / "photo.jpg"),
    )

    assert action.model_dump()["unit_id"] == "unit_123"
    assert action.companion_role == "edit_sidecar"
    assert action.unit_primary_path.endswith("photo.jpg")


def test_companion_heavy_discovery_stays_within_the_recorded_budget(tmp_path: Path) -> None:
    root = tmp_path / "library"
    root.mkdir()
    for index in range(500):
        (root / f"IMG_{index:04}.jpg").write_bytes(b"image")
        (root / f"IMG_{index:04}.xmp").write_bytes(b"xmp")
    stats = DiscoveryStats()

    started = monotonic()
    observations = list(walk(root, TraversalRules(), stats))
    elapsed = monotonic() - started

    assert len(observations) == 1_000
    assert stats.eligible_media == 500
    assert stats.companions == 500
    assert elapsed < 5.0
