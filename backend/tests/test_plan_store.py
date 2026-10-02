"""C-03: a reviewed plan must survive, and must refuse in a way you can act on.

A frozen plan is what makes a mutating run *reviewed* — the exact set of
consequences the user was shown. It lived in a dictionary on `PreviewService`,
so a backend restart discarded every plan, while the sort route treated
`plan_id` as optional and started anyway.

The three refusals are typed on purpose. "Expired", "corrupt" and "written by a
newer build" call for different actions, and answering all of them with "no such
plan" tells the user to re-preview when the real problem was forward
incompatibility.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from app.core.config import Config
from app.core.integrity import utc_now
from app.core.plan_store import (
    DIAGNOSTIC_RETENTION,
    EXECUTION_WINDOW,
    PLAN_STORE_FORMAT_VERSION,
    InvalidPlanStoreError,
    PlanExpiredError,
    PlanStore,
    UnsupportedPlanStoreVersionError,
    store_for_state_root,
)
from app.core.sort_plan import build_frozen_sort_plan


@pytest.fixture()
def store(tmp_path: Path) -> PlanStore:
    return store_for_state_root(tmp_path / "state")


def _plan(tmp_path: Path):  # type: ignore[no-untyped-def]
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    (source / "a.jpg").write_bytes(b"a")
    config = Config(source_directory=str(source), target_directory=str(tmp_path / "target"))
    items = [
        {
            "source": str(source / "a.jpg"),
            "destination": str(tmp_path / "target" / "2024" / "01" / "01" / "a.jpg"),
            "status": "sort",
            "file_size": 1,
        }
    ]
    return build_frozen_sort_plan(items, config)


class TestRoundTrip:
    def test_a_saved_plan_survives_a_restart(self, store: PlanStore, tmp_path: Path) -> None:
        """The whole point: a new process reads what the old one reviewed."""
        plan = _plan(tmp_path)
        store.save(plan)

        reopened = PlanStore(store.root)
        loaded = reopened.load(plan.plan_id)

        assert loaded.plan.plan_id == plan.plan_id
        assert loaded.plan.impact == plan.impact
        assert loaded.plan.actions == plan.actions

    def test_the_envelope_records_its_format_version(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        store.save(plan)

        envelope = json.loads(store.path_for(plan.plan_id).read_text(encoding="utf-8"))

        assert envelope["format_version"] == PLAN_STORE_FORMAT_VERSION
        assert envelope["plan_id"] == plan.plan_id
        assert set(envelope) == {
            "format_version",
            "plan_id",
            "created_at",
            "expires_at",
            "frozen_plan",
        }

    def test_no_temporary_file_is_left_behind(self, store: PlanStore, tmp_path: Path) -> None:
        """A half-written plan must never be a readable one."""
        plan = _plan(tmp_path)
        store.save(plan)

        assert [p.name for p in store.root.glob("*.tmp")] == []
        assert store.path_for(plan.plan_id).is_file()

    def test_preview_and_review_state_survive_without_rewriting_plan_identity(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        preview = {
            "plan_id": plan.plan_id,
            "config_fingerprint": plan.config_fingerprint,
            "items": [{"source": plan.actions[0].source_path}],
        }
        stored = store.save(plan, preview_result=preview)
        envelope_before_review = store.path_for(plan.plan_id).read_bytes()
        state = {
            "schema_version": 1,
            "config_fingerprint": plan.config_fingerprint,
            "decisions": [{"group_id": "set-1", "kind": "keeper", "member_id": "member-1"}],
            "selected_set_ids": ["set-1"],
            "mode": "resolve",
            "queue_set_id": "set-1",
            "detail_path": None,
            "viewer_path": None,
            "search": "",
            "tree_path": None,
            "view": "grid",
            "sort": "date",
            "keep_policy": "smart",
        }

        store.save_review_state(
            plan.plan_id,
            state,
            expected_config_fingerprint=plan.config_fingerprint,
        )
        reopened = PlanStore(store.root).load(plan.plan_id)

        assert reopened.plan == plan
        assert reopened.created_at == stored.created_at
        assert reopened.expires_at == stored.expires_at
        assert reopened.preview_result == preview
        assert reopened.review_state == state
        assert store.path_for(plan.plan_id).read_bytes() == envelope_before_review
        assert store.review_path_for(plan.plan_id).is_file()
        assert list(store.root.glob("*.tmp")) == []

    def test_review_state_refuses_a_different_configuration(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        store.save(plan, preview_result={"plan_id": plan.plan_id})

        with pytest.raises(InvalidPlanStoreError, match="configuration"):
            store.save_review_state(
                plan.plan_id,
                {"schema_version": 1},
                expected_config_fingerprint="different",
            )


class TestExpiry:
    def test_a_plan_is_executable_inside_its_window(self, store: PlanStore, tmp_path: Path) -> None:
        plan = _plan(tmp_path)
        stored = store.save(plan)

        assert stored.expires_at - stored.created_at == EXECUTION_WINDOW
        just_inside = stored.expires_at - timedelta(seconds=1)
        assert store.load(plan.plan_id, now=just_inside).plan.plan_id == plan.plan_id

    def test_an_expired_plan_is_refused_with_its_own_error(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        stored = store.save(plan)

        with pytest.raises(PlanExpiredError, match="expired"):
            store.load(plan.plan_id, now=stored.expires_at)

    def test_an_expired_plan_is_still_on_disk_for_diagnostics(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        """Expiry refuses execution; it does not destroy the evidence."""
        plan = _plan(tmp_path)
        stored = store.save(plan)

        with pytest.raises(PlanExpiredError):
            store.load(plan.plan_id, now=stored.expires_at + timedelta(days=1))

        assert store.path_for(plan.plan_id).is_file()

    def test_purging_only_removes_plans_past_the_diagnostic_window(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        stored = store.save(plan)

        assert store.purge_expired(now=stored.expires_at + timedelta(days=1)) == ()
        assert store.path_for(plan.plan_id).is_file()

        past = stored.expires_at + DIAGNOSTIC_RETENTION
        assert store.purge_expired(now=past) == (plan.plan_id,)
        assert not store.path_for(plan.plan_id).exists()

    def test_a_start_never_purges_implicitly(self, store: PlanStore, tmp_path: Path) -> None:
        """An expiry answered as "no such plan" is a worse answer."""
        plan = _plan(tmp_path)
        stored = store.save(plan)

        with pytest.raises(PlanExpiredError):
            store.load(plan.plan_id, now=stored.expires_at + DIAGNOSTIC_RETENTION)
        assert store.path_for(plan.plan_id).is_file()


class TestRefusals:
    def test_a_corrupt_envelope_is_quarantined_and_refused(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        store.save(plan)
        store.path_for(plan.plan_id).write_text("{ this is not json", encoding="utf-8")

        with pytest.raises(InvalidPlanStoreError, match="corrupt"):
            store.load(plan.plan_id)

        assert not store.path_for(plan.plan_id).exists()
        assert (store.quarantine_root / f"{plan.plan_id}.plan.json").is_file()

    def test_a_truncated_envelope_is_refused(self, store: PlanStore, tmp_path: Path) -> None:
        plan = _plan(tmp_path)
        store.save(plan)
        path = store.path_for(plan.plan_id)
        whole = path.read_text(encoding="utf-8")
        path.write_text(whole[: len(whole) // 2], encoding="utf-8")

        with pytest.raises(InvalidPlanStoreError):
            store.load(plan.plan_id)

    def test_a_newer_format_version_is_refused_loudly(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        """Never read leniently: a newer envelope may describe more consequences."""
        plan = _plan(tmp_path)
        store.save(plan)
        path = store.path_for(plan.plan_id)
        envelope = json.loads(path.read_text(encoding="utf-8"))
        envelope["format_version"] = PLAN_STORE_FORMAT_VERSION + 1
        path.write_text(json.dumps(envelope), encoding="utf-8")

        with pytest.raises(UnsupportedPlanStoreVersionError, match="format version"):
            store.load(plan.plan_id)

        # Refused, but not quarantined — it is perfectly valid, just not ours.
        assert path.is_file()

    def test_an_envelope_naming_a_different_plan_is_refused(
        self, store: PlanStore, tmp_path: Path
    ) -> None:
        plan = _plan(tmp_path)
        store.save(plan)
        path = store.path_for(plan.plan_id)
        envelope = json.loads(path.read_text(encoding="utf-8"))
        envelope["frozen_plan"]["plan_id"] = "some-other-plan"
        path.write_text(json.dumps(envelope), encoding="utf-8")

        with pytest.raises(InvalidPlanStoreError, match="identifies itself"):
            store.load(plan.plan_id)

    def test_an_absent_plan_is_refused_not_invented(self, store: PlanStore) -> None:
        with pytest.raises(InvalidPlanStoreError, match="no stored plan"):
            store.load("plan-that-never-existed")

    @pytest.mark.parametrize("plan_id", ["", "../escape", "nested/id", "..\\windows", ".hidden"])
    def test_a_plan_id_is_never_a_path(self, store: PlanStore, plan_id: str) -> None:
        """`plan_id` arrives in a request body, so it never becomes a path segment."""
        with pytest.raises(InvalidPlanStoreError, match="plan identifier"):
            store.path_for(plan_id)


def test_the_execution_and_diagnostic_windows_are_the_documented_ones() -> None:
    assert EXECUTION_WINDOW == timedelta(hours=24)
    assert DIAGNOSTIC_RETENTION == timedelta(days=7)


def test_plans_live_beside_the_journals_that_record_acting_on_them(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    assert store_for_state_root(state_root).root == state_root / "plans"


def test_a_plan_saved_now_is_not_already_expired(tmp_path: Path) -> None:
    store = store_for_state_root(tmp_path / "state")
    plan = _plan(tmp_path)

    stored = store.save(plan)

    assert not stored.is_expired(now=utc_now())
    assert not stored.is_purgeable(now=utc_now())
