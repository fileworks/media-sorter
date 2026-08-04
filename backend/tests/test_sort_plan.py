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
    build_frozen_sort_plan,
)
from app.services.operation_execution import OperationExecution


def _config(tmp_path: Path) -> Config:
    return Config(
        source_directory=str(tmp_path / "input"),
        target_directory=str(tmp_path / "output"),
        copy_instead_of_move=True,
    )


def _plan(tmp_path: Path):
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
# Exclusions                                                                    #
# --------------------------------------------------------------------------- #


def _unit_plan(tmp_path: Path):
    """A RAW+JPEG unit plus an unrelated file, so unit expansion is observable."""
    inputs = tmp_path / "input"
    inputs.mkdir()
    raw = inputs / "shot.raw"
    jpeg = inputs / "shot.jpg"
    other = inputs / "other.jpg"
    for path, payload in ((raw, b"raw bytes"), (jpeg, b"jpeg bytes"), (other, b"other bytes")):
        path.write_bytes(payload)
    config = _config(tmp_path)
    plan = build_frozen_sort_plan(
        [
            {
                "source": str(raw),
                "destination": str(tmp_path / "output" / "shot.raw"),
                "status": "sort",
                "file_size": raw.stat().st_size,
                "unit_id": "unit-shot",
                "companions": [],
            },
            {
                "source": str(jpeg),
                "destination": str(tmp_path / "output" / "shot.jpg"),
                "status": "sort",
                "file_size": jpeg.stat().st_size,
                "unit_id": "unit-shot",
                "companions": [],
            },
            {
                "source": str(other),
                "destination": str(tmp_path / "output" / "other.jpg"),
                "status": "sort",
                "file_size": other.stat().st_size,
                "unit_id": "unit-other",
                "companions": [],
            },
        ],
        config,
    )
    return config, raw, jpeg, other, plan


def _execution(tmp_path: Path, config: Config, plan):
    return OperationExecution.start(
        operation_id="exclusions",
        state_root=tmp_path / "state",
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        frozen_plan=plan,
    )


def test_excluding_a_companion_excludes_its_whole_unit(tmp_path: Path) -> None:
    _config_value, raw, jpeg, other, plan = _unit_plan(tmp_path)

    derived = plan.with_exclusions([str(jpeg)])

    assert derived.is_skipped(raw)
    assert derived.is_skipped(jpeg)
    assert not derived.is_skipped(other)


def test_exclusions_never_mutate_the_stored_plan(tmp_path: Path) -> None:
    _config_value, _raw, jpeg, _other, plan = _unit_plan(tmp_path)

    plan.with_exclusions([str(jpeg)])

    assert plan.skipped_sources == frozenset()


def test_an_excluded_source_is_never_attempted(tmp_path: Path) -> None:
    config, _raw, _jpeg, other, plan = _unit_plan(tmp_path)
    execution = _execution(tmp_path, config, plan.with_exclusions([str(other)]))
    before = other.read_bytes()

    result = execution.place(
        other,
        tmp_path / "output" / "other.jpg",
        kind="copy",
        move=False,
        root_id="input",
        relative_path="other.jpg",
        unit_id="unit-other",
    )

    assert result is None
    assert other.read_bytes() == before
    assert not (tmp_path / "output" / "other.jpg").exists()
    assert [outcome.code for outcome in execution.outcomes] == ["excluded"]


def test_an_unplanned_action_still_raises_when_others_are_excluded(tmp_path: Path) -> None:
    """The skip is not a hole in the whitelist — only the named sources skip."""
    config, _raw, _jpeg, other, plan = _unit_plan(tmp_path)
    execution = _execution(tmp_path, config, plan.with_exclusions([str(other)]))

    with pytest.raises(ValueError, match="differs from the reviewed plan"):
        execution.place(
            tmp_path / "input" / "shot.jpg",
            tmp_path / "output" / "somewhere-else.jpg",
            kind="copy",
            move=False,
            root_id="input",
            relative_path="shot.jpg",
            unit_id="unit-shot",
        )


def test_excluding_everything_completes_with_zero_actions(tmp_path: Path) -> None:
    config, raw, jpeg, other, plan = _unit_plan(tmp_path)
    everything = [str(raw), str(jpeg), str(other)]
    execution = _execution(tmp_path, config, plan.with_exclusions(everything))

    for source in (raw, jpeg, other):
        assert (
            execution.place(
                source,
                tmp_path / "output" / source.name,
                kind="copy",
                move=False,
                root_id="input",
                relative_path=source.name,
                unit_id="unit-shot",
            )
            is None
        )

    assert not (tmp_path / "output").exists()
    assert {outcome.code for outcome in execution.outcomes} == {"excluded"}


def test_an_excluded_file_is_reported_as_excluded_not_failed(tmp_path: Path) -> None:
    config, _raw, _jpeg, other, plan = _unit_plan(tmp_path)
    execution = _execution(tmp_path, config, plan.with_exclusions([str(other)]))

    execution.place(
        other,
        tmp_path / "output" / "other.jpg",
        kind="copy",
        move=False,
        root_id="input",
        relative_path="other.jpg",
        unit_id="unit-other",
    )

    assert execution.outcomes[0].code == "excluded"
    assert execution.outcomes[0].code != "failed"


# --------------------------------------------------------------------------- #
# Quarantine statuses                                                           #
# --------------------------------------------------------------------------- #


def _quarantine_plan(tmp_path: Path, status: str):
    """A preview item the *preview* sends to a review folder, frozen into a plan."""
    source = tmp_path / "input" / "photo.jpg"
    source.parent.mkdir()
    source.write_bytes(b"undated media")
    destination = tmp_path / "output" / "_unknown_dates" / "photo.jpg"
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


@pytest.mark.parametrize("status", ["unknown_date", "suspicious_date"])
def test_every_previewed_review_folder_placement_is_planned(tmp_path: Path, status: str) -> None:
    """A destination the preview showed must be one the executor may act on.

    `suspicious_date` is a file whose EXIF date failed the sanity check and left
    no usable date, so the preview sends it to `_unknown_dates/` exactly like
    `unknown_date`. When the plan did not include it, the run reached the
    whitelist with a placement nobody had authorized, recorded the file as
    *failed*, and told the user to generate the preview again — which produced
    the same plan and the same failure every time.
    """
    source, destination, plan = _quarantine_plan(tmp_path, status)

    assert plan.impact.quarantine_count == 1
    assert plan.impact.skip_count == 0
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
    """The preflight subtracts exclusions from this, so it has to be a count.

    It was `1 if actions else 0`. Execute reads
    `actionable_groups - (excluded transfers + excluded quarantine)` and refuses
    to start when that reaches zero, so excluding a single file blocked a run of
    any size with "every file is excluded" — and unreadable and undated files
    start excluded, so it fired on any real library.
    """
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


# --------------------------------------------------------------------------- #
# Impact after exclusions                                                       #
# --------------------------------------------------------------------------- #


def _unit_and_loose_plan(tmp_path: Path, *, copy_mode: bool = True):
    """A RAW+JPEG unit, a quarantined file, and a loose file."""
    source_dir = tmp_path / "input"
    source_dir.mkdir()
    jpeg = source_dir / "shot.jpg"
    jpeg.write_bytes(b"j" * 100)
    raw = source_dir / "shot.raw"
    raw.write_bytes(b"r" * 900)
    junk = source_dir / "thumb.png"
    junk.write_bytes(b"t" * 10)
    loose = source_dir / "other.jpg"
    loose.write_bytes(b"o" * 50)
    config = Config(
        source_directory=str(source_dir),
        target_directory=str(tmp_path / "output"),
        copy_instead_of_move=copy_mode,
    )
    plan = build_frozen_sort_plan(
        [
            {
                "source": str(jpeg),
                "destination": str(tmp_path / "output" / "2024" / "shot.jpg"),
                "status": "sort",
                "file_size": 100,
                "unit_id": "u1",
                "companions": [
                    {
                        "source": str(raw),
                        "destination": str(tmp_path / "output" / "2024" / "shot.raw"),
                        "role": "raw_sibling",
                        "status": "attached",
                    }
                ],
            },
            {
                "source": str(junk),
                "destination": str(tmp_path / "output" / "_junk" / "thumb.png"),
                "status": "junk",
                "file_size": 10,
                "companions": [],
            },
            {
                "source": str(loose),
                "destination": str(tmp_path / "output" / "2024" / "other.jpg"),
                "status": "sort",
                "file_size": 50,
                "companions": [],
            },
        ],
        config,
    )
    return jpeg, raw, junk, loose, plan


def test_excluding_a_unit_takes_its_companion_out_of_the_impact(tmp_path: Path) -> None:
    """The impact has to describe the run that will happen, companions included.

    Review excludes a *reviewed file*; the plan expands that to the whole media
    unit. The preflight then subtracted a per-file tally from action-level
    totals, so excluding a RAW+JPEG pair took one file and the JPEG's bytes off
    a total that held two files and both their bytes — it promised to copy one
    file needing 900 bytes when it would copy nothing.
    """
    jpeg, _raw, _junk, _loose, plan = _unit_and_loose_plan(tmp_path)

    assert plan.impact.copy_count == 3  # jpeg + raw + loose
    # Quarantined copies consume destination space too, so the junk file counts.
    assert plan.impact.required_bytes == 1060

    derived = plan.with_exclusions([str(jpeg)])

    assert derived.impact.copy_count == 1  # only the loose file survives
    assert derived.impact.required_bytes == 60  # loose 50 + quarantined junk 10
    assert derived.impact.quarantine_count == 1
    assert derived.impact.actionable_groups == 2


def test_impact_after_exclusions_always_matches_a_recount(tmp_path: Path) -> None:
    """Every subset, recounted from the surviving actions themselves."""
    jpeg, _raw, junk, loose, plan = _unit_and_loose_plan(tmp_path)
    candidates = [str(jpeg), str(junk), str(loose)]

    for mask in range(8):
        excluded = [path for index, path in enumerate(candidates) if mask >> index & 1]
        derived = plan.with_exclusions(excluded)
        surviving = derived.live_actions
        assert derived.impact.copy_count == sum(a.kind == "copy" for a in surviving), excluded
        assert derived.impact.move_count == sum(a.kind == "move" for a in surviving), excluded
        assert derived.impact.quarantine_count == sum(a.kind == "quarantine" for a in surviving), (
            excluded
        )
        assert derived.impact.actionable_groups == sum(
            a.companion_role is None for a in surviving
        ), excluded
        assert derived.impact.source_mutations == sum(
            a.source_effect != "retained" for a in surviving
        ), excluded


def test_source_mutations_drop_with_the_files_that_were_excluded(tmp_path: Path) -> None:
    """Move mode asks for an explicit acknowledgement; it must not overstate."""
    jpeg, _raw, _junk, _loose, plan = _unit_and_loose_plan(tmp_path, copy_mode=False)

    assert plan.impact.source_mutations == 4  # jpeg, raw, junk, loose

    derived = plan.with_exclusions([str(jpeg)])

    assert derived.impact.source_mutations == 2  # junk + loose
