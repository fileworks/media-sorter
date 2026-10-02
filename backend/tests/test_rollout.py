"""A gate that defaults on is not a gate, and readiness must be earned."""

from __future__ import annotations

import pytest

from app.core.rollout import (
    DEFAULTS,
    REQUIRED_SCALE,
    ParityEvidence,
    SchemaVersions,
    active_gates,
    describe,
    enabled,
    removal_readiness,
)


class TestGates:
    def test_every_gate_is_off_by_default(self) -> None:
        assert all(value is False for value in DEFAULTS.values())
        assert all(enabled(gate, environ={}) is False for gate in DEFAULTS)

    def test_the_environment_turns_one_on(self) -> None:
        assert enabled("persistent_catalog", environ={"MEDIASORT_GATE_PERSISTENT_CATALOG": "on"})
        assert enabled("persistent_catalog", environ={"MEDIASORT_GATE_PERSISTENT_CATALOG": "1"})

    def test_anything_else_leaves_it_off(self) -> None:
        for value in ("", "off", "false", "maybe", "0"):
            assert (
                enabled("multi_root_profile", environ={"MEDIASORT_GATE_MULTI_ROOT_PROFILE": value})
                is False
            )

    def test_the_description_names_what_is_on(self) -> None:
        assert "No rollout gates" in describe()

    def test_gate_state_is_reported_for_every_gate(self) -> None:
        assert set(active_gates(environ={})) == set(DEFAULTS)


class TestSchemaBinding:
    def test_matching_versions_are_compatible(self) -> None:
        assert SchemaVersions().compatible_with(SchemaVersions())

    def test_a_moved_schema_is_not(self) -> None:
        assert not SchemaVersions().compatible_with(SchemaVersions(catalog=99))
        assert not SchemaVersions().compatible_with(SchemaVersions(profile=99))


class TestRemovalReadiness:
    def test_nothing_is_ready_before_anything_is_observed(self) -> None:
        readiness = removal_readiness(ParityEvidence())

        assert readiness.ready is False
        assert len(readiness.missing) == 6
        assert "outstanding" in readiness.summary

    def test_each_missing_check_is_named(self) -> None:
        readiness = removal_readiness(
            ParityEvidence(
                exact_duplicates_match=True,
                perceptual_duplicates_match=True,
                preview_rows_match=True,
                migration_observed=True,
                repeated_run_reuses_work=True,
                scale_runs=(20_000,),
            )
        )

        assert readiness.ready is False
        assert "20,000 records" in readiness.missing[0]

    def test_a_fully_observed_path_may_be_removed(self) -> None:
        readiness = removal_readiness(
            ParityEvidence(
                exact_duplicates_match=True,
                perceptual_duplicates_match=True,
                preview_rows_match=True,
                migration_observed=True,
                repeated_run_reuses_work=True,
                scale_runs=(20_000, REQUIRED_SCALE, 2_000_000),
            )
        )

        assert readiness.ready is True
        assert readiness.missing == ()
        assert "may be removed" in readiness.summary

    @pytest.mark.parametrize(
        "field",
        [
            "exact_duplicates_match",
            "perceptual_duplicates_match",
            "preview_rows_match",
            "migration_observed",
            "repeated_run_reuses_work",
        ],
    )
    def test_any_single_gap_blocks_removal(self, field: str) -> None:
        evidence = ParityEvidence(
            exact_duplicates_match=True,
            perceptual_duplicates_match=True,
            preview_rows_match=True,
            migration_observed=True,
            repeated_run_reuses_work=True,
            scale_runs=(2_000_000,),
        )
        setattr(evidence, field, False)

        assert removal_readiness(evidence).ready is False


class TestObservedParity:
    """What this build has actually shown, recorded where it can be checked."""

    def test_the_recorded_evidence_matches_the_test_suite(self) -> None:
        # Each flag below corresponds to a test that exists and passes:
        #   exact/perceptual parity  → tests/test_catalog_duplicates.py
        #   repeated-run reuse       → tests/test_discovery.py, test_scale_tiers.py
        #   migration observed       → tests/test_state_lifecycle.py
        #   preview rows             → not yet: the legacy PreviewList still
        #                              builds its own array, so no comparison
        #                              between the two has been run.
        observed = ParityEvidence(
            exact_duplicates_match=True,
            perceptual_duplicates_match=True,
            preview_rows_match=False,
            migration_observed=True,
            repeated_run_reuses_work=True,
            scale_runs=(20_000, 200_000, 2_000_000),
        )

        readiness = removal_readiness(observed)

        # The legacy path stays until preview parity is demonstrated. This
        # assertion is the record of that decision, and it will fail — usefully —
        # the day somebody records the missing evidence and forgets to remove it.
        assert readiness.ready is False
        assert readiness.missing == ("preview rows have not been shown to match",)
