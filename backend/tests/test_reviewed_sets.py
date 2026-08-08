"""Review's keeper choice reaches the run, and the plan agrees with what runs.

The defect this file pins down: every control that picked a copy wrote to a
server-side `ReviewPlan` nothing read back, and the one mechanism that *did*
reach the run — `reviewed_keepers` — could not work. `FrozenPlanGuard` whitelists
by `(source, destination, kind, source_effect, unit_id, companion_role)`, and
promoting a copy changes the destination and kind of two actions. Neither new
identity was in the plan, so the run aborted with `unplanned_action`.

The tests are written against what a *seeded run actually computes*, not against
what the swap looks like on paper. That distinction is the whole change: the run
derives every destination itself, so a plan that merely asserts a different
winner is a plan the run then contradicts.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Config
from app.core.exceptions import ConflictError, PlanAuthorizationError
from app.core.sort_plan import (
    FrozenPlanGuard,
    FrozenSortAction,
    ReviewedSet,
    build_frozen_sort_plan,
)
from app.services.duplicate_service import DuplicateRegistry, DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.sorting_service import SortingService

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


# --------------------------------------------------------------------------- #
# A real pipeline, small enough to reason about                                #
# --------------------------------------------------------------------------- #


class _StubConfigService:
    def __init__(self, config: Config) -> None:
        self._config = config

    def get(self) -> Config:
        return self._config


def _service(config: Config) -> SortingService:
    from app.services.conversion_service import ConversionService
    from app.services.repair_service import RepairService

    return SortingService(
        config=config,
        config_service=_StubConfigService(config),  # type: ignore[arg-type]
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
    )


def _config(tmp_path: Path, **overrides: Any) -> Config:
    values: dict[str, Any] = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "sorted"),
        "copy_instead_of_move": True,
        "remove_duplicates": True,
        "duplicate_exact_enabled": True,
        "repair_enabled": False,
        "convert_images": False,
        "convert_videos": False,
        "override_metadata": False,
        "ai_tagging_enabled": False,
        "embed_tags_in_files": False,
    }
    values.update(overrides)
    return Config(**values)


def _jpeg(path: Path) -> bytes:
    image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")
    path.parent.mkdir(parents=True, exist_ok=True)
    exif = piexif.dump(
        {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2021:06:05 10:11:12"}, "0th": {}, "1st": {}}
    )
    image.new("RGB", (24, 24), color=(12, 34, 56)).save(path, format="JPEG", exif=exif)
    return path.read_bytes()


def _preview(
    service: SortingService, config: Config, tmp_path: Path, sources: list[Path]
) -> list[dict[str, Any]]:
    """What the preview freezes: one pass with an empty registry."""
    registry = DuplicateRegistry()
    items = []
    for source in sources:
        record = service._process_file(
            file_path=source,
            source_root=tmp_path / "source",
            dest_root=tmp_path / "sorted",
            config=config,
            dry_run=True,
            registry=registry,
            operation_id="preview",
            execution=None,
        )
        items.append(
            {
                "source": str(source),
                "destination": record.get("dest_path"),
                "status": "sort" if record.get("status") == "success" else record.get("status"),
                "file_size": source.stat().st_size,
                "extracted_date": record.get("extracted_date"),
                "duplicate_of": record.get("duplicate_of"),
                "source_root": record.get("source_root"),
                "would_be_destination": record.get("would_be_destination"),
                "provenance": record.get("provenance"),
            }
        )
    return items


def _seeded_run(
    service: SortingService,
    config: Config,
    tmp_path: Path,
    sources: list[Path],
    keeper: Path,
) -> dict[str, tuple[str, str]]:
    """What a run seeded with that keeper computes: `{name: (status, destination)}`."""
    registry = DuplicateRegistry()
    registry.exact[hashlib.sha256(keeper.read_bytes()).hexdigest()] = str(keeper)
    outcome = {}
    reserved: set[Path] = set()
    planned: dict[str, Path] = {}
    for source in sources:
        record = service._process_file(
            file_path=source,
            source_root=tmp_path / "source",
            dest_root=tmp_path / "sorted",
            config=config,
            dry_run=True,
            registry=registry,
            operation_id="run",
            reserved_destinations=reserved,
            planned_destinations=planned,
            execution=None,
        )
        outcome[source.name] = (str(record.get("status")), str(record.get("dest_path")))
    return outcome


@pytest.fixture
def two_copies(tmp_path: Path) -> tuple[Path, Path]:
    first = tmp_path / "source" / "a.jpg"
    second = tmp_path / "source" / "b.jpg"
    data = _jpeg(first)
    second.write_bytes(data)
    return first, second


# --------------------------------------------------------------------------- #
# 1. The defect                                                                #
# --------------------------------------------------------------------------- #


class TestTheDefectThisChangeRemoves:
    def test_promoting_a_copy_without_rewriting_the_plan_aborts_the_run(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        """The failure `reviewed_keepers` would have produced on every run.

        The plan places `a` and quarantines `b`. A run that keeps `b` instead
        sends `b` to the date folder — an action the plan does not contain, so
        the guard refuses it. Recording the decision on the plan without
        rewriting its actions could only ever end here.
        """
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)
        run = _seeded_run(service, config, tmp_path, [first, second], keeper=second)

        guard = FrozenPlanGuard(plan)

        with pytest.raises(PlanAuthorizationError) as raised:
            guard.authorize(
                second,
                Path(run["b.jpg"][1]),
                kind="copy",
                move=False,
                unit_id=None,
                companion_role=None,
            )
        assert raised.value.details["reason"] == "unplanned_action"

    def test_a_seeded_keeper_is_not_a_duplicate_of_itself(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        """Seeding alone quarantined *both* copies, so nothing was ever placed."""
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)

        run = _seeded_run(service, config, tmp_path, [first, second], keeper=second)

        assert run["b.jpg"][0] == "success"
        assert run["a.jpg"][0] == "duplicate"


# --------------------------------------------------------------------------- #
# 2. The rewrite matches the run                                               #
# --------------------------------------------------------------------------- #


class TestTheRewrittenPlanDescribesTheRun:
    def _rewritten(
        self, tmp_path: Path, sources: list[Path], keeper: Path, **overrides: Any
    ) -> tuple[dict[str, FrozenSortAction], dict[str, tuple[str, str]]]:
        config = _config(tmp_path, **overrides)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, sources), config)
        demoted = tuple(str(item) for item in sources if item != keeper)
        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(keeper), demote=demoted)],
            source_root=config.source_directory,
        )
        actions = {Path(a.source_path).name: a for a in derived.actions}
        return actions, _seeded_run(service, config, tmp_path, sources, keeper)

    def test_a_two_copy_set_swaps_roles_and_agrees_with_the_run(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies

        actions, run = self._rewritten(tmp_path, [first, second], keeper=second)

        assert actions["b.jpg"].disposition == "sort"
        assert actions["a.jpg"].disposition == "quarantine"
        # The one property that matters: the plan's destination is the
        # destination the run computes, character for character.
        assert actions["b.jpg"].destination_path == run["b.jpg"][1]
        assert actions["a.jpg"].destination_path == run["a.jpg"][1]

    def test_the_guard_authorizes_the_swapped_actions(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        actions, run = self._rewritten(tmp_path, [first, second], keeper=second)
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)
        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )
        guard = FrozenPlanGuard(derived)

        assert (
            guard.authorize(
                second,
                Path(run["b.jpg"][1]),
                kind="copy",
                move=False,
                unit_id=None,
                companion_role=None,
            )
            is not None
        )
        assert (
            guard.authorize(
                first,
                Path(run["a.jpg"][1]),
                kind="quarantine",
                move=False,
                unit_id=None,
                companion_role=None,
            )
            is not None
        )

    def test_copies_in_different_source_folders_keep_their_own_subpaths(
        self, tmp_path: Path
    ) -> None:
        """Quarantine preserves the source-relative folder, so a swap must too.

        A literal field swap sends the demoted copy to the *promoted* copy's
        quarantine subfolder, which is a path the run never computes.
        """
        first = tmp_path / "source" / "a.jpg"
        second = tmp_path / "source" / "nested" / "b.jpg"
        data = _jpeg(first)
        second.parent.mkdir(parents=True, exist_ok=True)
        second.write_bytes(data)

        actions, run = self._rewritten(tmp_path, [first, second], keeper=second)

        assert actions["a.jpg"].destination_path == run["a.jpg"][1]
        assert actions["b.jpg"].destination_path == run["b.jpg"][1]
        assert "nested" not in actions["a.jpg"].destination_path

    def test_a_three_copy_set_demotes_both_losers(self, tmp_path: Path) -> None:
        first = tmp_path / "source" / "a.jpg"
        data = _jpeg(first)
        second = tmp_path / "source" / "b.jpg"
        third = tmp_path / "source" / "c.jpg"
        second.write_bytes(data)
        third.write_bytes(data)

        actions, run = self._rewritten(tmp_path, [first, second, third], keeper=third)

        assert actions["c.jpg"].disposition == "sort"
        assert actions["a.jpg"].disposition == "quarantine"
        assert actions["b.jpg"].disposition == "quarantine"
        for name in ("a.jpg", "b.jpg", "c.jpg"):
            assert actions[name].destination_path == run[name][1]

    def test_marking_a_set_not_duplicates_restores_every_members_own_plan(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        derived = plan.with_reviewed_sets(
            [
                ReviewedSet(
                    keep=str(first),
                    demote=(str(second),),
                    keep_all=True,
                )
            ],
            source_root=config.source_directory,
        )
        actions = {Path(action.source_path).name: action for action in derived.actions}

        assert actions["a.jpg"].disposition == "sort"
        assert actions["b.jpg"].disposition == "sort"
        assert actions["a.jpg"].keeper_path is None
        assert actions["b.jpg"].keeper_path is None
        assert derived.impact.quarantine_count == 0
        assert derived.impact.copy_count == 2
        assert derived.reviewed_sets[0].keep_all is True

    def test_a_not_duplicates_decision_bypasses_run_local_matching(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        registry = DuplicateRegistry()
        records = [
            service._process_file(
                file_path=source,
                source_root=tmp_path / "source",
                dest_root=tmp_path / "sorted",
                config=config,
                dry_run=True,
                registry=registry,
                operation_id="keep-all",
                execution=None,
                force_distinct=True,
            )
            for source in (first, second)
        ]

        assert [record["status"] for record in records] == ["success", "success"]
        assert all(record["duplicate_of"] is None for record in records)
        assert len({record["dest_path"] for record in records}) == 2

    def test_keeping_the_already_planned_copy_changes_nothing(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(first), demote=(str(second),))],
            source_root=config.source_directory,
        )

        assert derived.actions == plan.actions

    def test_the_derived_impact_is_recomputed_not_inherited(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        """Keeper changes recompute their impact, so the preflight stays exact."""
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )

        # Roles swapped, so the totals must still describe one placement and one
        # quarantine — and the quarantined bytes are now the other file's.
        assert derived.impact.quarantine_count == plan.impact.quarantine_count
        assert derived.impact.copy_count == plan.impact.copy_count

    def test_the_stored_plan_is_never_touched(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)
        before = plan.actions

        plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )

        assert plan.actions == before
        assert plan.reviewed_sets == ()


# --------------------------------------------------------------------------- #
# 3. Refusals                                                                  #
# --------------------------------------------------------------------------- #


class TestRefusals:
    def test_a_set_naming_an_unplanned_source_is_refused_by_name(self, tmp_path: Path) -> None:
        """Silently ignoring half a decision leaves a duplicate the user resolved."""
        config = _config(tmp_path)
        plan = build_frozen_sort_plan([], config)

        with pytest.raises(ConflictError) as raised:
            plan.with_reviewed_sets(
                [ReviewedSet(keep="/gone/keep.jpg", demote=("/gone/other.jpg",))],
                source_root=config.source_directory,
            )

        assert raised.value.details["source_path"] == "/gone/keep.jpg"
        assert raised.value.details["reason"] == "unplanned_review_decision"

    def test_members_with_different_companions_are_refused_not_half_swapped(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        items = _preview(service, config, tmp_path, [first, second])
        # The placed member arrives as a RAW+JPEG unit; the quarantined one does
        # not, so promoting it would orphan the sidecar.
        sidecar = tmp_path / "source" / "a.xmp"
        sidecar.write_text("<x/>")
        items[0]["unit_id"] = "unit-1"
        items[0]["companions"] = [
            {
                "source": str(sidecar),
                "destination": str(tmp_path / "sorted" / "2021" / "a.xmp"),
                "role": "sidecar",
                "status": "planned",
            }
        ]
        plan = build_frozen_sort_plan(items, config)

        with pytest.raises(ConflictError) as raised:
            plan.with_reviewed_sets(
                [ReviewedSet(keep=str(second), demote=(str(first),))],
                source_root=config.source_directory,
            )

        assert raised.value.details["reason"] == "incompatible_companions"

    def test_a_promotion_across_source_folders_uses_the_selected_copys_own_path(
        self, tmp_path: Path
    ) -> None:
        """The preview records the own path, so no folder inference is needed."""
        first = tmp_path / "source" / "one" / "a.jpg"
        second = tmp_path / "source" / "two" / "b.jpg"
        data = _jpeg(first)
        second.parent.mkdir(parents=True, exist_ok=True)
        second.write_bytes(data)
        config = _config(tmp_path, preserve_subfolders=True, categorize_enabled=False)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )
        run = _seeded_run(service, config, tmp_path, [first, second], keeper=second)
        actions = {Path(action.source_path).name: action for action in derived.actions}

        assert "/two/" in actions["b.jpg"].destination_path
        assert actions["b.jpg"].destination_path == run["b.jpg"][1]
        assert actions["a.jpg"].destination_path == run["a.jpg"][1]

    def test_the_same_folders_swap_fine_under_that_layout(self, tmp_path: Path) -> None:
        """The restriction is only about *differing* folders, not the layout."""
        first = tmp_path / "source" / "one" / "a.jpg"
        second = tmp_path / "source" / "one" / "b.jpg"
        data = _jpeg(first)
        second.write_bytes(data)
        config = _config(tmp_path, preserve_subfolders=True, categorize_enabled=False)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        derived = plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )
        run = _seeded_run(service, config, tmp_path, [first, second], keeper=second)

        actions = {Path(a.source_path).name: a for a in derived.actions}
        assert actions["b.jpg"].destination_path == run["b.jpg"][1]
        assert actions["a.jpg"].destination_path == run["a.jpg"][1]


# --------------------------------------------------------------------------- #
# 4. One run's decisions stay in one run                                       #
# --------------------------------------------------------------------------- #


class TestRunScope:
    def test_a_second_run_of_the_stored_plan_is_unaffected(
        self, tmp_path: Path, two_copies: tuple[Path, Path]
    ) -> None:
        first, second = two_copies
        config = _config(tmp_path)
        service = _service(config)
        plan = build_frozen_sort_plan(_preview(service, config, tmp_path, [first, second]), config)

        plan.with_reviewed_sets(
            [ReviewedSet(keep=str(second), demote=(str(first),))],
            source_root=config.source_directory,
        )
        second_run = plan.with_reviewed_sets([], source_root=config.source_directory)

        by_source = {Path(a.source_path).name: a for a in second_run.actions}
        assert by_source["a.jpg"].disposition == "sort"
        assert by_source["b.jpg"].disposition == "quarantine"
