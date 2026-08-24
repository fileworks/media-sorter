"""Preflight, the quarantine manager, and the one action that cannot be undone."""

from __future__ import annotations

import hashlib
import subprocess
import sys
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

    def test_a_record_failure_leaves_recoverable_intent_and_retry_converges(
        self, store: QuarantineStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg", b"retry me")
        original_append = store._append
        calls = {"count": 0}

        def fail_once(record: object) -> object:
            calls["count"] += 1
            if calls["count"] == 1:
                raise OSError("record volume interrupted")
            return original_append(record)  # type: ignore[arg-type]

        monkeypatch.setattr(store, "_append", fail_once)
        with pytest.raises(OSError, match="record volume interrupted"):
            store.quarantine(source, operation_id="op-retry", reason="duplicate")

        assert not source.exists()
        reopened = QuarantineStore(store.root)
        assert len(reopened.pending_intents()) == 1

        record = reopened.quarantine(source, operation_id="op-retry", reason="duplicate")

        assert len(reopened.records()) == 1
        assert len(reopened.pending_intents()) == 0
        assert Path(record.quarantine_path).read_bytes() == b"retry me"

    def test_a_legacy_pending_intent_adopts_its_existing_artifact(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        """Pre-destination intents remain recoverable after an upgrade."""
        source = _file(tmp_path / "library" / "copy.jpg", b"legacy transfer")
        expected = hashlib.sha256(source.read_bytes()).hexdigest()
        intent = store.declare_intent(
            source,
            operation_id="op-legacy",
            reason="duplicate",
            expected_sha256=expected,
        )
        artifact = store.root / "duplicate" / source.name
        artifact.parent.mkdir(parents=True)
        source.replace(artifact)

        reopened = QuarantineStore(store.root)
        record = reopened.quarantine(source, operation_id="op-legacy", reason="duplicate")

        assert record.record_id == f"qtn_{intent.intent_id.removeprefix('qti_')}"
        assert Path(record.quarantine_path) == artifact
        assert artifact.read_bytes() == b"legacy transfer"
        assert len(reopened.records()) == 1
        assert reopened.pending_intents() == ()

    def test_a_shipped_intent_without_digest_or_path_adopts_one_artifact(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg", b"old schema transfer")
        intent = store.declare_intent(
            source,
            operation_id="op-old-schema",
            reason="optimization_original",
        )
        artifact = store.root / "optimization_original" / source.name
        artifact.parent.mkdir(parents=True)
        source.replace(artifact)

        reopened = QuarantineStore(store.root)
        records = [
            reopened.quarantine(
                source,
                operation_id="op-old-schema",
                reason="optimization_original",
            )
            for _attempt in range(4)
        ]

        assert {record.record_id for record in records} == {
            f"qtn_{intent.intent_id.removeprefix('qti_')}"
        }
        assert {record.quarantine_path for record in records} == {str(artifact)}
        assert len(reopened.records()) == 1
        assert reopened.pending_intents() == ()
        upgraded = reopened.intents()[0]
        assert upgraded.expected_sha256 == hashlib.sha256(b"old schema transfer").hexdigest()
        assert upgraded.quarantine_path == str(artifact)

    def test_first_intent_fsyncs_the_new_store_entry_in_its_parent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.services import quarantine as quarantine_module

        root = tmp_path / "state" / "nested" / "quarantine"
        source = _file(tmp_path / "library" / "copy.jpg")
        synced: list[Path] = []
        monkeypatch.setattr(quarantine_module, "_fsync_directory", synced.append)

        QuarantineStore(root).declare_intent(
            source,
            operation_id="op-first",
            reason="duplicate",
        )

        assert root.parent in synced
        assert root in synced

    def test_a_committed_intent_with_a_lost_record_republishes_that_record(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg", b"publish once")
        first = store.quarantine(source, operation_id="op-commit", reason="duplicate")
        store.records_path.write_text("", encoding="utf-8")
        reopened = QuarantineStore(store.root)
        assert len(reopened.pending_intents()) == 1

        recovered = reopened.quarantine(source, operation_id="op-commit", reason="duplicate")

        assert recovered.record_id == first.record_id
        assert recovered.quarantine_path == first.quarantine_path
        assert Path(recovered.quarantine_path).read_bytes() == b"publish once"
        assert len(reopened.records()) == 1
        assert reopened.pending_intents() == ()

    def test_process_death_after_transfer_before_record_converges_on_retry(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg", b"survive process death")
        child = """
import os, sys
from pathlib import Path
from app.services.quarantine import QuarantineStore
store = QuarantineStore(Path(sys.argv[1]))
store._append = lambda _record: os._exit(91)
store.quarantine(Path(sys.argv[2]), operation_id='op-kill', reason='duplicate')
"""
        completed = subprocess.run(
            [sys.executable, "-c", child, str(store.root), str(source)], check=False
        )
        assert completed.returncode == 91
        assert not source.exists()
        reopened = QuarantineStore(store.root)
        assert len(reopened.pending_intents()) == 1

        results = [
            reopened.quarantine(source, operation_id="op-kill", reason="duplicate")
            for _attempt in range(5)
        ]

        assert len({record.record_id for record in results}) == 1
        assert len({record.quarantine_path for record in results}) == 1
        assert len(reopened.records()) == 1
        assert len(reopened.records_path.read_text(encoding="utf-8").splitlines()) == 1
        assert reopened.pending_intents() == ()
        artifacts = tuple((store.root / "duplicate").iterdir())
        assert len(artifacts) == 1
        assert artifacts[0].read_bytes() == b"survive process death"

    def test_commit_failure_after_record_reuses_the_single_published_record(
        self, store: QuarantineStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg", b"record is durable")
        original_append_intent = store._append_intent

        def fail_commit(intent: object) -> object:
            if getattr(intent, "state", None) == "committed":
                raise OSError("intent commit interrupted")
            return original_append_intent(intent)  # type: ignore[arg-type]

        monkeypatch.setattr(store, "_append_intent", fail_commit)
        with pytest.raises(OSError, match="intent commit interrupted"):
            store.quarantine(source, operation_id="op-commit-fail", reason="duplicate")
        assert not source.exists()
        assert len(store.records()) == 1
        monkeypatch.undo()

        reopened = QuarantineStore(store.root)
        recovered = reopened.quarantine(source, operation_id="op-commit-fail", reason="duplicate")

        assert recovered == reopened.records()[0]
        assert len(reopened.records()) == 1
        assert len(reopened.records_path.read_text(encoding="utf-8").splitlines()) == 1
        assert reopened.pending_intents() == ()


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
