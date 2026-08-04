"""Resuming may save time; it may never reuse work that no longer applies."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from app.core.catalog_schema import CATALOG_SCHEMA_VERSION
from app.core.library_profiles import DurableCheckpoint
from app.services.catalog import MediaCatalog
from app.services.resume import (
    STAGES,
    ResumeReport,
    load_checkpoint,
    plan_resume,
    save_checkpoint,
)

ALGORITHMS = {"hash": "1", "media_facts": "1", "signature": "1", "thumbnail": "1", "planner": "1"}


@pytest.fixture()
def catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        yield opened


def _checkpoint(**overrides: Any) -> DurableCheckpoint:
    fields: dict[str, Any] = {
        "operation_id": "op1",
        "profile_id": "profile-1",
        "profile_schema_version": 1,
        "catalog_schema_version": CATALOG_SCHEMA_VERSION,
        "phase": "hashing",
        "state": "active",
        "high_water_marks": {"root-a": 500},
        "algorithm_versions": dict(ALGORITHMS),
    }
    fields.update(overrides)
    # Overrides are arbitrary by design, so this call is dynamic.
    return DurableCheckpoint(**fields)  # type: ignore[arg-type]


def _compatibility(**overrides):
    base = {
        "profile_id": "profile-1",
        "profile_schema_version": 1,
        "catalog_schema_version": CATALOG_SCHEMA_VERSION,
        "algorithm_versions": dict(ALGORITHMS),
        "known_root_ids": ("root-a",),
    }
    base.update(overrides)
    return base


class TestPersistence:
    def test_a_checkpoint_round_trips_through_the_catalog(self, catalog: MediaCatalog) -> None:
        save_checkpoint(catalog, _checkpoint(), cursor=1_000)

        loaded = load_checkpoint(catalog, "op1")

        assert loaded is not None
        assert loaded.phase == "hashing"
        assert loaded.high_water_marks == {"root-a": 500}

    def test_an_absent_checkpoint_is_none_not_an_error(self, catalog: MediaCatalog) -> None:
        assert load_checkpoint(catalog, "never-saved") is None

    def test_a_damaged_checkpoint_is_ignored_rather_than_fatal(self, catalog: MediaCatalog) -> None:
        catalog.save_checkpoint("op1", cursor=1, payload="{not json")

        assert load_checkpoint(catalog, "op1") is None

    def test_the_newest_checkpoint_replaces_the_previous_one(self, catalog: MediaCatalog) -> None:
        save_checkpoint(catalog, _checkpoint(phase="discovery"), cursor=1)
        save_checkpoint(catalog, _checkpoint(phase="signatures"), cursor=2)

        assert (load_checkpoint(catalog, "op1") or _checkpoint()).phase == "signatures"


class TestCompatibility:
    def test_no_checkpoint_starts_fresh_with_everything_available(self) -> None:
        plan = plan_resume(None, **_compatibility())

        assert plan.decision == "start_fresh"
        assert plan.reusable == STAGES

    def test_an_unchanged_world_resumes_everything(self) -> None:
        plan = plan_resume(_checkpoint(), **_compatibility())

        assert plan.decision == "resume"
        assert plan.reusable == STAGES
        assert plan.invalidated == ()

    def test_a_different_profile_invalidates_all_of_it(self) -> None:
        plan = plan_resume(_checkpoint(), **_compatibility(profile_id="profile-2"))

        assert plan.decision == "restart"
        assert plan.reusable == ()
        assert plan.blocked_reason is not None

    def test_a_changed_catalog_schema_invalidates_all_of_it(self) -> None:
        plan = plan_resume(
            _checkpoint(catalog_schema_version=CATALOG_SCHEMA_VERSION + 1),
            **_compatibility(),
        )

        assert plan.decision == "restart"
        assert "index format" in (plan.blocked_reason or "")

    def test_a_changed_profile_format_invalidates_all_of_it(self) -> None:
        plan = plan_resume(_checkpoint(profile_schema_version=2), **_compatibility())

        assert plan.decision == "restart"

    def test_a_finished_operation_is_not_resumed(self) -> None:
        plan = plan_resume(_checkpoint(state="completed"), **_compatibility())

        assert plan.decision == "start_fresh"


class TestStageInvalidation:
    def test_a_changed_hasher_invalidates_hashing_and_everything_after_it(self) -> None:
        plan = plan_resume(
            _checkpoint(),
            **_compatibility(algorithm_versions={**ALGORITHMS, "hash": "2"}),
        )

        assert plan.decision == "resume"
        assert plan.reusable == ("discovery",)
        assert {item.stage for item in plan.invalidated} == set(STAGES[1:])

    def test_a_changed_signature_extractor_leaves_hashes_alone(self) -> None:
        plan = plan_resume(
            _checkpoint(),
            **_compatibility(algorithm_versions={**ALGORITHMS, "signature": "9"}),
        )

        assert "hashing" in plan.reusable
        assert "signatures" not in plan.reusable
        assert plan.reuses_expensive_work is True

    def test_every_invalidation_carries_a_reason_a_user_can_read(self) -> None:
        plan = plan_resume(
            _checkpoint(),
            **_compatibility(algorithm_versions={**ALGORITHMS, "thumbnail": "3"}),
        )

        assert plan.explanations
        assert all("changed from" in text for text in plan.explanations)

    def test_one_reason_per_stage_even_when_several_algorithms_changed(self) -> None:
        plan = plan_resume(
            _checkpoint(),
            **_compatibility(algorithm_versions={**ALGORITHMS, "hash": "2", "signature": "2"}),
        )

        stages = [item.stage for item in plan.invalidated]
        assert len(stages) == len(set(stages))

    def test_a_root_that_left_the_profile_invalidates_discovery(self) -> None:
        plan = plan_resume(_checkpoint(), **_compatibility(known_root_ids=("root-b",)))

        assert "discovery" not in plan.reusable
        assert any("no longer in the profile" in text for text in plan.explanations)

    def test_an_unknown_algorithm_name_changes_nothing(self) -> None:
        plan = plan_resume(
            _checkpoint(algorithm_versions={**ALGORITHMS, "mystery": "1"}),
            **_compatibility(algorithm_versions={**ALGORITHMS, "mystery": "2"}),
        )

        assert plan.reusable == STAGES


class TestReport:
    def test_the_headline_says_what_is_happening(self) -> None:
        clean = ResumeReport(plan=plan_resume(_checkpoint(), **_compatibility()))
        redoing = ResumeReport(
            plan=plan_resume(
                _checkpoint(),
                **_compatibility(algorithm_versions={**ALGORITHMS, "signature": "5"}),
            )
        )
        starting = ResumeReport(plan=plan_resume(None, **_compatibility()))

        assert clean.headline == "Continuing where the last run stopped"
        assert "redoing" in redoing.headline
        assert starting.headline == "Starting a new scan"

    def test_an_incompatible_plan_says_it_is_starting_over(self) -> None:
        report = ResumeReport(plan=plan_resume(_checkpoint(), **_compatibility(profile_id="x")))

        assert "Starting over" in report.headline
