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
