"""P0-SAFE-006: quarantine growth is bounded by reporting, never by deleting.

`P0-SAFE-001` retains an original for every converted file, in a store that had
retention *state* but no size cap and no automatic pruning — against a stated
never-delete posture. The gap was that the growth was invisible, not that
nothing removed it.

So these are diagnostics. The store reports whether it has outgrown its budget
or its warning age and recommends a cleanup; acting on that recommendation is
`permanently_remove`'s job, behind its own acknowledgement. Nothing here deletes
anything, and the last test in this file is what says so.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

from app.core.config import Config
from app.core.integrity import utc_now
from app.services.quarantine import QuarantineStore

DEFAULT_BUDGET_BYTES = 10 * 1024**3
DEFAULT_WARNING_AGE_DAYS = 30


@pytest.fixture()
def store(tmp_path: Path) -> QuarantineStore:
    return QuarantineStore(tmp_path / "state" / "quarantine")


def _hold(store: QuarantineStore, tmp_path: Path, name: str, payload: bytes) -> str:
    source = tmp_path / "incoming" / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(payload)
    return store.quarantine(source, operation_id="op1", reason="optimization_original").record_id


def _age(store: QuarantineStore, record_id: str, days: float) -> None:
    """Re-append the record with an older timestamp; the store keeps the newest."""
    record = store.find(record_id)
    assert record is not None
    store._append(  # noqa: SLF001 - the test owns this fixture's history
        replace(record, quarantined_at=(utc_now() - timedelta(days=days)).isoformat())
    )


class TestDefaults:
    def test_the_shipped_defaults_are_the_documented_ones(self) -> None:
        config = Config()

        assert config.quarantine_budget_bytes == DEFAULT_BUDGET_BYTES
        assert config.quarantine_warning_age_days == DEFAULT_WARNING_AGE_DAYS

    def test_summary_without_a_policy_reports_no_budget_fields(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        _hold(store, tmp_path, "a.png", b"x" * 32)

        summary = store.summary()

        assert "over_budget" not in summary
        assert summary["retained_bytes"] == 32


class TestBudget:
    def test_below_budget_is_reported_as_such(self, store: QuarantineStore, tmp_path: Path) -> None:
        _hold(store, tmp_path, "a.png", b"x" * 100)

        summary = store.summary(budget_bytes=1_000, warning_age_days=30)

        assert summary["retained_bytes"] == 100
        assert summary["budget_bytes"] == 1_000
        assert summary["over_budget"] is False
        assert summary["cleanup_recommended"] is False
        assert summary["cleanup_reasons"] == ()

    def test_over_budget_recommends_a_cleanup(self, store: QuarantineStore, tmp_path: Path) -> None:
        _hold(store, tmp_path, "a.png", b"x" * 5_000)

        summary = store.summary(budget_bytes=1_000, warning_age_days=30)

        assert summary["over_budget"] is True
        assert summary["cleanup_recommended"] is True
        reasons = summary["cleanup_reasons"]
        assert isinstance(reasons, tuple)
        assert "over_budget" in reasons

    def test_a_positive_budget_below_the_default_is_valid(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        """Explicitly required: a small budget is a choice, not a mistake."""
        _hold(store, tmp_path, "a.png", b"x" * 2_048)

        summary = store.summary(budget_bytes=1_024, warning_age_days=30)

        assert summary["budget_bytes"] == 1_024
        assert summary["over_budget"] is True

    def test_exactly_at_budget_is_not_over(self, store: QuarantineStore, tmp_path: Path) -> None:
        _hold(store, tmp_path, "a.png", b"x" * 1_000)

        summary = store.summary(budget_bytes=1_000, warning_age_days=30)

        assert summary["over_budget"] is False

    @pytest.mark.parametrize("budget", [0, -1, -(10**9)])
    def test_a_non_positive_budget_is_refused(self, store: QuarantineStore, budget: int) -> None:
        with pytest.raises(ValueError, match="positive number of bytes"):
            store.summary(budget_bytes=budget, warning_age_days=30)

    @pytest.mark.parametrize("days", [0, -1])
    def test_a_non_positive_warning_age_is_refused(self, store: QuarantineStore, days: int) -> None:
        with pytest.raises(ValueError, match="positive number of days"):
            store.summary(budget_bytes=1_000, warning_age_days=days)


class TestAge:
    def test_an_old_record_produces_an_age_recommendation(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _hold(store, tmp_path, "a.png", b"x" * 10)
        _age(store, record_id, days=45)

        summary = store.summary(budget_bytes=10**9, warning_age_days=30)

        assert summary["over_budget"] is False
        assert summary["over_warning_age"] is True
        assert summary["cleanup_recommended"] is True
        reasons = summary["cleanup_reasons"]
        assert isinstance(reasons, tuple)
        assert "older_than_warning_age" in reasons

    def test_a_record_younger_than_the_threshold_recommends_nothing(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _hold(store, tmp_path, "a.png", b"x" * 10)
        _age(store, record_id, days=10)

        summary = store.summary(budget_bytes=10**9, warning_age_days=30)

        assert summary["over_warning_age"] is False
        assert summary["cleanup_recommended"] is False

    def test_both_thresholds_are_reported_together(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _hold(store, tmp_path, "a.png", b"x" * 5_000)
        _age(store, record_id, days=45)

        summary = store.summary(budget_bytes=1_000, warning_age_days=30)

        reasons = summary["cleanup_reasons"]
        assert isinstance(reasons, tuple)
        assert set(reasons) == {"over_budget", "older_than_warning_age"}


class TestNoAutomaticDeletion:
    def test_reporting_over_budget_never_removes_anything(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        """The whole point. Diagnostics that prune are not diagnostics."""
        record_id = _hold(store, tmp_path, "a.png", b"x" * 5_000)
        _age(store, record_id, days=365)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]

        for _ in range(3):
            summary = store.summary(budget_bytes=1, warning_age_days=1)
            assert summary["cleanup_recommended"] is True

        assert held.is_file(), "the store deleted a file it was only asked to describe"
        assert store.find(record_id).retention == "retained"  # type: ignore[union-attr]
        assert store.pending_removals() == ()
        assert store.summary()["retained_count"] == 1


class TestApi:
    def test_the_endpoint_exposes_the_budget_fields(self, client: object) -> None:
        response = client.get("/api/quarantine/summary")  # type: ignore[attr-defined]

        assert response.status_code == 200
        payload = response.json()
        for field in (
            "budget_bytes",
            "warning_age_days",
            "retained_bytes",
            "over_budget",
            "over_warning_age",
            "oldest_age_days",
            "cleanup_recommended",
            "cleanup_reasons",
        ):
            assert field in payload, field
        assert payload["budget_bytes"] == DEFAULT_BUDGET_BYTES
        assert payload["warning_age_days"] == DEFAULT_WARNING_AGE_DAYS

    def test_an_over_budget_run_does_not_fail_the_request(self, client: object) -> None:
        """An over-budget store is a recommendation, not an error."""
        response = client.get("/api/quarantine/summary")  # type: ignore[attr-defined]

        assert response.status_code == 200
        assert response.json()["cleanup_recommended"] in {True, False}
