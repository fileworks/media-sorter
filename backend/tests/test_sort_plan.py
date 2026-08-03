from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity_policy import authorize_config_mutations
from app.core.sort_plan import FrozenPlanGuard, build_frozen_sort_plan
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
