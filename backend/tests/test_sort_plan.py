from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity_policy import authorize_config_mutations
from app.core.sort_plan import (
    PLANNED_QUARANTINE_STATUSES,
    FrozenPlanGuard,
    FrozenSortPlan,
    build_frozen_sort_plan,
)
from app.services.operation_execution import OperationExecution


def _config(tmp_path: Path) -> Config:
    return Config(
        source_directory=str(tmp_path / "input"),
        target_directory=str(tmp_path / "output"),
        copy_instead_of_move=True,
    )


def _plan(tmp_path: Path) -> tuple[Config, Path, Path, FrozenSortPlan]:
    source = tmp_path / "input" / "photo.jpg"
    source.parent.mkdir()
    source.write_bytes(b"reviewed media")
    destination = tmp_path / "output" / "2024" / "photo.jpg"
    config = _config(tmp_path)
    plan = build_frozen_sort_plan(
        [
            {
                "source": str(source),
                "destination": str(destination),
                "status": "sort",
                "file_size": source.stat().st_size,
                "unit_id": "unit-photo",
                "companions": [],
            }
        ],
        config,
    )
    return config, source, destination, plan


def test_preview_impact_is_derived_from_the_frozen_actions(tmp_path: Path) -> None:
    config, source, destination, plan = _plan(tmp_path)

    assert plan.config_fingerprint == config_fingerprint(config)
    assert plan.impact.actionable_groups == 1
    assert plan.impact.copy_count == 1
    assert plan.impact.move_count == 0
    assert plan.impact.required_bytes == source.stat().st_size
    assert plan.actions[0].destination_path == str(destination)
    assert plan.actions[0].reviewed_destination_path == str(destination)


def test_executor_consumes_reviewed_action_and_refuses_any_other_destination(
    tmp_path: Path,
) -> None:
    config, source, destination, plan = _plan(tmp_path)
    execution = OperationExecution.start(
        operation_id="frozen-plan",
        state_root=tmp_path / "state",
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        frozen_plan=plan,
    )

    with pytest.raises(ValueError, match="differs from the reviewed plan"):
        execution.place(
            source,
            tmp_path / "output" / "wrong.jpg",
            kind="copy",
            move=False,
            root_id="input",
            relative_path="photo.jpg",
            unit_id="unit-photo",
        )
    assert not (tmp_path / "output" / "wrong.jpg").exists()

    execution.place(
        source,
        destination,
        kind="copy",
        move=False,
        root_id="input",
        relative_path="photo.jpg",
        unit_id="unit-photo",
    )
    assert destination.read_bytes() == b"reviewed media"


def test_source_drift_is_rejected_before_any_destination_write(tmp_path: Path) -> None:
    _config_value, source, destination, plan = _plan(tmp_path)
    guard = FrozenPlanGuard(plan)
    source.write_bytes(b"changed after review")

    with pytest.raises(ValueError, match="changed after preview"):
        guard.authorize(
            source,
            destination,
            kind="copy",
            move=False,
            unit_id="unit-photo",
            companion_role=None,
        )
    assert not destination.exists()


def test_changed_final_destination_is_rejected_before_transfer(tmp_path: Path) -> None:
    _config_value, source, _destination, plan = _plan(tmp_path)
    guard = FrozenPlanGuard(plan)

    with pytest.raises(ValueError, match="final destination differs"):
        guard.verify_final_destination(
            source,
            tmp_path / "output" / "different-name.jpg",
            unit_id="unit-photo",
            companion_role=None,
        )


# --------------------------------------------------------------------------- #
# Quarantine statuses                                                           #
# --------------------------------------------------------------------------- #


def _quarantine_plan(tmp_path: Path, status: str) -> tuple[Path, Path, FrozenSortPlan]:
    """A preview item the *preview* sends to a review folder, frozen into a plan."""
    source = tmp_path / "input" / "photo.jpg"
    source.parent.mkdir()
    source.write_bytes(b"undated media")
    folder = "_corrupted" if status == "failed" else "_undated"
    destination = tmp_path / "output" / folder / "photo.jpg"
    config = _config(tmp_path)
    plan = build_frozen_sort_plan(
        [
            {
                "source": str(source),
                "destination": str(destination),
                "status": status,
                "file_size": source.stat().st_size,
                "companions": [],
            }
        ],
        config,
    )
    return source, destination, plan


@pytest.mark.parametrize("status", ["unknown_date", "suspicious_date", "failed"])
def test_every_previewed_review_folder_placement_is_planned(tmp_path: Path, status: str) -> None:
    """A destination the preview showed must be one the executor may act on.

    Suspicious/undated files go to `_undated/`; unreadable files go to
    `_corrupted/`. Every destination shown for review must therefore be in the
    executor's whitelist rather than failing again as an unplanned action.
    """
    source, destination, plan = _quarantine_plan(tmp_path, status)

    assert plan.impact.quarantine_count == 1
    assert plan.impact.skip_count == 0
    assert plan.impact.unresolved_count == 0
    assert [action.destination_path for action in plan.actions] == [str(destination)]

    guard = FrozenPlanGuard(plan)
    assert (
        guard.authorize(
            source,
            destination,
            kind="quarantine",
            move=False,
            unit_id=None,
            companion_role=None,
        )
        is not None
    )


def test_actionable_groups_counts_planned_files_not_merely_whether_any_exist(
    tmp_path: Path,
) -> None:
    """Preflight needs the real number of primary actions, not an any/none flag."""
    source_dir = tmp_path / "input"
    source_dir.mkdir()
    items = []
    for index in range(5):
        source = source_dir / f"photo{index}.jpg"
        source.write_bytes(b"media")
        items.append(
            {
                "source": str(source),
                "destination": str(tmp_path / "output" / "2024" / f"photo{index}.jpg"),
                "status": "sort",
                "file_size": source.stat().st_size,
                "companions": [],
            }
        )
    plan = build_frozen_sort_plan(items, _config(tmp_path))

    assert plan.impact.actionable_groups == 5
    # Excluding one still leaves four for the run to act on.
    assert plan.impact.actionable_groups - 1 == 4


def test_actionable_groups_counts_a_unit_once_not_once_per_companion(tmp_path: Path) -> None:
    """Exclusions are counted per reviewed file, so companions must not inflate it."""
    source_dir = tmp_path / "input"
    source_dir.mkdir()
    raw = source_dir / "shot.raw"
    raw.write_bytes(b"raw")
    jpeg = source_dir / "shot.jpg"
    jpeg.write_bytes(b"jpeg")
    plan = build_frozen_sort_plan(
        [
            {
                "source": str(jpeg),
                "destination": str(tmp_path / "output" / "2024" / "shot.jpg"),
                "status": "sort",
                "file_size": jpeg.stat().st_size,
                "unit_id": "unit-1",
                "companions": [
                    {
                        "source": str(raw),
                        "destination": str(tmp_path / "output" / "2024" / "shot.raw"),
                        "role": "raw_sibling",
                        "status": "attached",
                    }
                ],
            }
        ],
        _config(tmp_path),
    )

    assert len(plan.actions) == 2
    assert plan.impact.actionable_groups == 1


# --------------------------------------------------------------------------- #
# Freeze → authorize round trip                                                 #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("copy_mode", [True, False])
@pytest.mark.parametrize("status", ["sort", *sorted(PLANNED_QUARANTINE_STATUSES)])
def test_every_planned_status_round_trips_from_freeze_to_authorization(
    tmp_path: Path,
    status: str,
    copy_mode: bool,
) -> None:
    """What the preview froze is what the executor is allowed to do.

    The action identity is a hash over source, destination, kind, source effect,
    unit and companion role. Any drift between the two sides becomes a refused
    placement, which the run then reports against the file — so the round trip
    is asserted for every status the preview can freeze, under both transfer
    modes, rather than for the one case that happened to be covered.
    """
    source_dir = tmp_path / "input"
    source_dir.mkdir()
    source = source_dir / "photo.jpg"
    source.write_bytes(b"media bytes")
    quarantined = status != "sort"
    destination = (
        tmp_path / "output" / "_unknown_dates" / "photo.jpg"
        if quarantined
        else tmp_path / "output" / "2024" / "photo.jpg"
    )
    config = Config(
        source_directory=str(source_dir),
        target_directory=str(tmp_path / "output"),
        copy_instead_of_move=copy_mode,
    )

    plan = build_frozen_sort_plan(
        [
            {
                "source": str(source),
                "destination": str(destination),
                "status": status,
                "file_size": source.stat().st_size,
                "companions": [],
            }
        ],
        config,
    )

    assert len(plan.actions) == 1, f"{status} froze no action"
    action = plan.actions[0]
    assert action.kind == ("quarantine" if quarantined else ("copy" if copy_mode else "move"))

    guard = FrozenPlanGuard(plan)
    authorized = guard.authorize(
        source,
        Path(action.destination_path),
        kind=action.kind,
        move=not copy_mode,
        unit_id=action.unit_id,
        companion_role=action.companion_role,
    )
    assert authorized is not None
    assert guard.remaining == ()


def test_a_companion_that_vanished_before_freezing_does_not_break_the_plan(
    tmp_path: Path,
) -> None:
    """A scan and a preview are not the same instant.

    The companion's size was read with a bare `stat()`, so a sidecar deleted
    between the two raised `OSError` out of plan construction and lost the whole
    preview rather than the one file that had gone.
    """
    source_dir = tmp_path / "input"
    source_dir.mkdir()
    jpeg = source_dir / "shot.jpg"
    jpeg.write_bytes(b"jpeg bytes")
    missing_raw = source_dir / "shot.raw"  # never created

    plan = build_frozen_sort_plan(
        [
            {
                "source": str(jpeg),
                "destination": str(tmp_path / "output" / "2024" / "shot.jpg"),
                "status": "sort",
                "file_size": jpeg.stat().st_size,
                "unit_id": "unit-1",
                "companions": [
                    {
                        "source": str(missing_raw),
                        "destination": str(tmp_path / "output" / "2024" / "shot.raw"),
                        "role": "raw_sibling",
                        "status": "attached",
                    }
                ],
            }
        ],
        _config(tmp_path),
    )

    assert [action.source_path for action in plan.actions] == [str(jpeg)]
    assert plan.impact.actionable_groups == 1
