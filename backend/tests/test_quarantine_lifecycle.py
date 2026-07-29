"""Preflight, the quarantine manager, and the one action that cannot be undone."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.quarantine import (
    CleanupRefused,
    QuarantineStore,
    permanently_remove,
    preflight,
    preview_cleanup,
    store_for_state_root,
)


@pytest.fixture()
def store(tmp_path: Path) -> QuarantineStore:
    return store_for_state_root(tmp_path / "state")


def _file(path: Path, content: bytes = b"content") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


class TestPreflight:
    def test_a_stale_plan_blocks_everything(self, tmp_path: Path) -> None:
        result = preflight(quarantine_bytes=10, plan_is_fresh=False, quarantine_root=tmp_path / "q")

        assert result.ready is False
        assert "review the affected groups" in result.blocked_reasons[0]

    def test_a_conflict_blocks_with_its_own_reason(self, tmp_path: Path) -> None:
        result = preflight(
            quarantine_bytes=1,
            quarantine_root=tmp_path / "q",
            conflicts=("two members would land on the same path",),
        )

        assert result.ready is False
        assert "same path" in result.blocked_reasons[0]

    def test_space_is_required_with_a_margin(self, tmp_path: Path) -> None:
        result = preflight(quarantine_bytes=1_000, destination_bytes=1_000, destination=tmp_path)

        assert result.required_bytes == 2_500  # 25% margin, deliberately conservative

    def test_an_impossible_amount_of_space_is_refused(self, tmp_path: Path) -> None:
        result = preflight(quarantine_bytes=10**18, destination=tmp_path)

        assert result.ready is False
        assert "free space" in result.blocked_reasons[0]

    def test_a_writable_quarantine_passes_and_warns_about_disk_use(self, tmp_path: Path) -> None:
        result = preflight(quarantine_bytes=10, quarantine_root=tmp_path / "quarantine")

        assert result.ready is True
        assert result.quarantine_available is True
        assert any("nothing is deleted" in warning for warning in result.warnings)

    def test_the_headline_is_usable_directly(self, tmp_path: Path) -> None:
        assert preflight(quarantine_bytes=0, quarantine_root=tmp_path).headline == "Ready to run"


class TestManager:
    def test_the_manager_shows_reason_keeper_and_age(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        keeper = _file(tmp_path / "library" / "kept.jpg")
        record = store.quarantine(
            _file(tmp_path / "library" / "copy.jpg"),
            operation_id="op1",
            reason="duplicate",
            keeper_path=keeper,
        )

        assert record.reason == "duplicate"
        assert record.keeper_path == str(keeper)
        assert record.age_days >= 0.0
        assert record.retention == "retained"

    def test_nothing_is_ever_deleted_automatically(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record = store.quarantine(_file(tmp_path / "a.jpg"), operation_id="op1", reason="duplicate")

        # A second, unrelated operation must not touch the first one's records.
        store.quarantine(_file(tmp_path / "b.jpg"), operation_id="op2", reason="junk")

        assert Path(record.quarantine_path).is_file()
        assert store.summary()["retained_count"] == 2


class TestPermanentRemoval:
    def test_the_preview_freezes_exactly_what_would_be_destroyed(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        first = store.quarantine(
            _file(tmp_path / "a.jpg", b"1234"), operation_id="op", reason="duplicate"
        )
        second = store.quarantine(
            _file(tmp_path / "b.jpg", b"12"), operation_id="op", reason="duplicate"
        )

        impact = preview_cleanup(store, [first.record_id, second.record_id])

        assert impact.item_count == 2
        assert impact.total_bytes == 6
        assert "cannot be undone" in impact.acknowledgement_text

    def test_removal_without_an_acknowledgement_is_refused(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record = store.quarantine(_file(tmp_path / "a.jpg"), operation_id="op", reason="duplicate")
        impact = preview_cleanup(store, [record.record_id])

        with pytest.raises(CleanupRefused):
            permanently_remove(store, impact, acknowledged=False)
        assert Path(record.quarantine_path).is_file()

    def test_an_acknowledged_removal_deletes_and_records_it(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record = store.quarantine(
            _file(tmp_path / "a.jpg", b"1234"), operation_id="op", reason="duplicate"
        )
        impact = preview_cleanup(store, [record.record_id])

        outcome = permanently_remove(store, impact, acknowledged=True)

        assert outcome.code == "completed"
        assert outcome.bytes_removed == 4
        assert not Path(record.quarantine_path).exists()
        assert (store.find(record.record_id) or record).retention == "removed"

    def test_an_already_restored_record_is_excluded_from_the_preview(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record = store.quarantine(
            _file(tmp_path / "lib" / "a.jpg"), operation_id="op", reason="duplicate"
        )
        store.restore(record)

        impact = preview_cleanup(store, [record.record_id])

        assert impact.item_count == 0
        assert impact.excluded_reasons

    def test_cancellation_stops_between_files_and_reports_partial_work(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        records = [
            store.quarantine(
                _file(tmp_path / f"{index}.jpg", b"x" * 10),
                operation_id="op",
                reason="duplicate",
            )
            for index in range(4)
        ]
        impact = preview_cleanup(store, [record.record_id for record in records])
        calls = {"count": 0}

        def cancel() -> bool:
            calls["count"] += 1
            return calls["count"] > 2

        outcome = permanently_remove(store, impact, acknowledged=True, cancel=cancel)

        assert outcome.cancelled is True
        assert outcome.code == "cancelled"
        assert len(outcome.removed) == 2

    def test_a_missing_file_is_reported_rather_than_silently_succeeding(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record = store.quarantine(_file(tmp_path / "a.jpg"), operation_id="op", reason="duplicate")
        impact = preview_cleanup(store, [record.record_id])
        store.restore(record)  # the record is no longer eligible

        outcome = permanently_remove(store, impact, acknowledged=True)

        assert outcome.code == "failed"
        assert outcome.failed and outcome.failed[0][1] == "no longer eligible"
