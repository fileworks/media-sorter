"""The compensating migration for `P1-FS-006(b)`, tested before the widening.

§17.18 Gate 3 requires the rollback path to exist before the forward-only change
does. This is that path: it makes a plan store readable again by a build from
before `expected_size_bytes` could be `null`.

The behaviour that matters is what it *declines* to do. A migration that removed
every plan would also pass "the old build can read what is left", so each test
here is paired with one asserting the plans it must not touch are still there.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest


def _module() -> ModuleType:
    path = Path(__file__).parents[2] / "scripts" / "downgrade_plan_store.py"
    spec = importlib.util.spec_from_file_location("downgrade_plan_store", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIGRATION = _module()


def _plan(root: Path, plan_id: str, sizes: list[int | None]) -> Path:
    envelope = {
        "format_version": 1,
        "plan_id": plan_id,
        "created_at": "2026-08-19T00:00:00+00:00",
        "expires_at": "2026-08-20T00:00:00+00:00",
        "frozen_plan": {
            "plan_id": plan_id,
            "actions": [{"expected_size_bytes": size} for size in sizes],
        },
    }
    path = root / f"{plan_id}.plan.json"
    path.write_text(json.dumps(envelope), encoding="utf-8")
    return path


class TestItIdentifiesOnlyWhatAnOlderBuildCannotRead:
    def test_a_plan_with_a_null_size_is_affected(self, tmp_path: Path) -> None:
        _plan(tmp_path, "plan-a", [10, None, 30])

        assert [path.name for path in MIGRATION.affected_plans(tmp_path)] == ["plan-a.plan.json"]

    def test_a_plan_with_only_integers_is_left_alone(self, tmp_path: Path) -> None:
        _plan(tmp_path, "plan-b", [10, 20])

        assert MIGRATION.affected_plans(tmp_path) == []

    def test_a_zero_size_is_not_an_unknown_one(self, tmp_path: Path) -> None:
        """`0` is a measured answer; treating it as unknown re-creates C-10."""
        _plan(tmp_path, "plan-c", [0, 0])

        assert MIGRATION.affected_plans(tmp_path) == []

    def test_an_already_unreadable_file_is_not_this_migration_s_business(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / "broken.plan.json").write_text("{not json", encoding="utf-8")

        assert MIGRATION.affected_plans(tmp_path) == []


class TestItWritesNothingWithoutApply:
    def test_a_dry_run_leaves_every_file_in_place(self, tmp_path: Path) -> None:
        affected = _plan(tmp_path, "plan-a", [None])
        untouched = _plan(tmp_path, "plan-b", [10])

        MIGRATION.run(tmp_path, apply=False)

        assert affected.is_file()
        assert untouched.is_file()
        assert list(tmp_path.glob("pre-downgrade-*")) == []


class TestApplyBacksUpBeforeRemoving:
    def test_the_affected_plan_is_removed(self, tmp_path: Path) -> None:
        affected = _plan(tmp_path, "plan-a", [None])

        MIGRATION.run(tmp_path, apply=True)

        assert not affected.exists()

    def test_its_content_survives_in_a_backup(self, tmp_path: Path) -> None:
        original = _plan(tmp_path, "plan-a", [None]).read_text(encoding="utf-8")

        MIGRATION.run(tmp_path, apply=True)

        backups = list(tmp_path.glob("pre-downgrade-*/plan-a.plan.json"))
        assert len(backups) == 1
        assert backups[0].read_text(encoding="utf-8") == original

    def test_a_readable_plan_is_never_removed(self, tmp_path: Path) -> None:
        """The guard against a migration that simply empties the store."""
        keep = _plan(tmp_path, "plan-b", [10, 20])
        _plan(tmp_path, "plan-a", [None])

        MIGRATION.run(tmp_path, apply=True)

        assert keep.is_file()

    def test_an_empty_store_is_a_no_op(self, tmp_path: Path) -> None:
        assert MIGRATION.run(tmp_path, apply=True) == 0
        assert list(tmp_path.glob("pre-downgrade-*")) == []

    def test_a_missing_store_is_a_no_op(self, tmp_path: Path) -> None:
        assert MIGRATION.run(tmp_path / "nowhere", apply=True) == 0


class TestTheStructuralReaderSurvivesAReadModel:
    def test_it_does_not_import_the_application(self) -> None:
        """It must run against a build whose model has already been reverted.

        Parsing the envelope through `FrozenSortPlan` would fail on exactly the
        plans this script exists to clear.
        """
        source = (Path(__file__).parents[2] / "scripts" / "downgrade_plan_store.py").read_text(
            encoding="utf-8"
        )

        assert "from app" not in source
        assert "import app" not in source


@pytest.mark.parametrize("sizes", [[None], [1, None], [None, 2]])
def test_any_null_anywhere_in_the_action_list_counts(
    tmp_path: Path, sizes: list[int | None]
) -> None:
    _plan(tmp_path, "plan-a", sizes)

    assert len(MIGRATION.affected_plans(tmp_path)) == 1
