"""C-02: the one action in the product that cannot be undone.

`permanently_remove` was a bare `unlink(missing_ok=True)`:

* nothing revalidated the recorded SHA-256, so a **tampered or replaced** file
  was destroyed as readily as the one the record described;
* nothing checked the path was a regular file, so a **symlink** was followed;
* `missing_ok=True` meant an **absent path counted as a successful deletion**,
  adding its bytes to the freed total;
* the record was appended *after* the unlink, so a crash in between left the
  record claiming ``retained`` for a file that no longer existed.

Every test here asserts the same thing from a different angle: a refusal leaves
the file where it was, and a crash is reported rather than hidden.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.services.quarantine import (
    QuarantineStore,
    permanently_remove,
    preview_cleanup,
)


@pytest.fixture()
def store(tmp_path: Path) -> QuarantineStore:
    return QuarantineStore(tmp_path / "state" / "quarantine")


def _quarantined(
    store: QuarantineStore,
    tmp_path: Path,
    payload: bytes = b"original bytes",
    *,
    name: str = "photo.jpg",
) -> str:
    source = tmp_path / "incoming" / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(payload)
    record = store.quarantine(source, operation_id="op1", reason="duplicate")
    return record.record_id


def _remove(store: QuarantineStore, record_id: str) -> object:
    return permanently_remove(
        store, preview_cleanup(store, [record_id]), acknowledged=True, operation_id="cleanup1"
    )


class TestRefusals:
    def test_a_tampered_file_is_refused_and_remains(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]
        held.write_bytes(b"someone changed this after it was recorded")

        outcome = _remove(store, record_id)

        assert outcome.failed == ((record_id, "hash_drift"),)  # type: ignore[attr-defined]
        assert outcome.removed == ()  # type: ignore[attr-defined]
        assert outcome.bytes_removed == 0  # type: ignore[attr-defined]
        assert held.is_file(), "a file that failed its proof must not be destroyed"
        assert store.find(record_id).retention == "retained"  # type: ignore[union-attr]
        assert store.pending_removals() == ()

    def test_a_symlink_in_place_of_the_object_is_refused(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]
        elsewhere = tmp_path / "someone-elses-file.jpg"
        elsewhere.write_bytes(b"not mine to delete")
        held.unlink()
        held.symlink_to(elsewhere)

        outcome = _remove(store, record_id)

        assert outcome.removed == ()  # type: ignore[attr-defined]
        assert "symlink" in outcome.failed[0][1]  # type: ignore[attr-defined]
        assert elsewhere.read_bytes() == b"not mine to delete"
        assert held.is_symlink()

    def test_a_replacement_inode_is_refused(self, store: QuarantineStore, tmp_path: Path) -> None:
        """Same path, different object. The digest is what settles it.

        Deliberately no inode assertion: an earlier version of this test checked
        that the replacement got a *different* `st_ino`, which holds on APFS and
        does not on ext4 — CI reused the number and the test failed on a
        precondition that had nothing to do with the behaviour under test. What
        matters is that the bytes differ from the ones recorded, and that is
        what `permanently_remove` checks.
        """
        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]
        original_bytes = held.read_bytes()
        held.unlink()
        held.write_bytes(b"a different file at the same path")
        assert held.read_bytes() != original_bytes

        outcome = _remove(store, record_id)

        assert outcome.failed == ((record_id, "hash_drift"),)  # type: ignore[attr-defined]
        assert held.is_file()

    def test_a_missing_path_is_reported_rather_than_counted_as_removed(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        Path(store.find(record_id).quarantine_path).unlink()  # type: ignore[union-attr]

        outcome = _remove(store, record_id)

        assert outcome.removed == ()  # type: ignore[attr-defined]
        assert outcome.bytes_removed == 0  # type: ignore[attr-defined]
        assert "no longer exists" in outcome.failed[0][1]  # type: ignore[attr-defined]
        # The record is not marked removed on the strength of an absent file.
        assert store.find(record_id).retention == "retained"  # type: ignore[union-attr]

    def test_a_directory_at_the_path_is_refused(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]
        held.unlink()
        held.mkdir()

        outcome = _remove(store, record_id)

        assert outcome.removed == ()  # type: ignore[attr-defined]
        assert held.is_dir()

    def test_removal_without_acknowledgement_destroys_nothing(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        from app.services.quarantine import CleanupRefused

        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]

        with pytest.raises(CleanupRefused):
            permanently_remove(store, preview_cleanup(store, [record_id]), acknowledged=False)

        assert held.is_file()


class TestSuccessAndRecovery:
    def test_a_verified_object_is_destroyed_and_recorded(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        held = Path(store.find(record_id).quarantine_path)  # type: ignore[union-attr]

        outcome = _remove(store, record_id)

        assert outcome.removed == (record_id,)  # type: ignore[attr-defined]
        assert outcome.code == "completed"  # type: ignore[attr-defined]
        assert not held.exists()
        assert store.find(record_id).retention == "removed"  # type: ignore[union-attr]
        # Nothing left half-done, and no tombstone left behind.
        assert store.pending_removals() == ()
        assert list(store.tombstone_root.glob("*")) == []

    def test_a_crash_after_the_intent_leaves_it_pending_not_removed(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        """The window the old code could not describe at all."""
        record_id = _quarantined(store, tmp_path)
        record = store.find(record_id)
        assert record is not None

        intent = store.declare_removal(record, operation="cleanup1")
        # ... the process dies here, between the intent and the tombstone.

        assert store.pending_removals() == (intent,)
        assert store.find(record_id).retention == "retained"  # type: ignore[union-attr]
        # A fresh reader of the same on-disk state agrees.
        reopened = QuarantineStore(store.root)
        assert len(reopened.pending_removals()) == 1
        assert reopened.pending_removals()[0].record_id == record_id

    def test_an_abandoned_removal_is_not_pending_and_not_removed(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        record_id = _quarantined(store, tmp_path)
        record = store.find(record_id)
        assert record is not None

        intent = store.declare_removal(record, operation="cleanup1")
        store.abandon_removal(intent, "volume went read-only")

        assert store.pending_removals() == ()
        assert store.removals()[0].state == "abandoned"
        assert store.find(record_id).retention == "retained"  # type: ignore[union-attr]

    def test_an_unwritable_record_journal_is_a_failure_not_a_silent_success(
        self, store: QuarantineStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.services.quarantine import QuarantineError

        record_id = _quarantined(store, tmp_path)

        def refuse(*args: object, **kwargs: object) -> object:
            raise QuarantineError("records.jsonl is read-only")

        monkeypatch.setattr(store, "_append", refuse)

        outcome = _remove(store, record_id)

        assert outcome.removed == ()  # type: ignore[attr-defined]
        assert "could not be appended" in outcome.failed[0][1]  # type: ignore[attr-defined]
        # Reported, and still visible to recovery rather than lost.
        assert len(store.pending_removals()) == 1

    def test_cancellation_stops_before_the_next_object(
        self, store: QuarantineStore, tmp_path: Path
    ) -> None:
        # Durable quarantine intents intentionally converge retries for one
        # source identity. Use two distinct source objects to test cancellation
        # between independent cleanup items.
        first = _quarantined(store, tmp_path, b"first", name="first.jpg")
        second = _quarantined(store, tmp_path, b"second", name="second.jpg")
        impact = preview_cleanup(store, [first, second])
        calls = {"n": 0}

        def cancel() -> bool:
            calls["n"] += 1
            return calls["n"] > 1

        outcome = permanently_remove(
            store, impact, acknowledged=True, cancel=cancel, operation_id="cleanup1"
        )

        assert outcome.cancelled is True
        assert len(outcome.removed) == 1
        assert store.pending_removals() == ()


def test_optimization_originals_are_eligible_for_cleanup(
    store: QuarantineStore, tmp_path: Path
) -> None:
    """Regression guard for `P0-SAFE-006`, which budgets these.

    `P0-SAFE-001` puts a retained original in the store for every converted
    file, so `preview_cleanup` has to see that reason as eligible — otherwise
    the growth `P0-SAFE-006` reports could never be acted on.
    """
    source = tmp_path / "incoming" / "shot.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"the pre-conversion original")
    record = store.quarantine(source, operation_id="op1", reason="optimization_original")

    impact = preview_cleanup(store, [record.record_id])

    assert impact.record_ids == (record.record_id,)
    assert impact.item_count == 1
    assert "cannot be undone" in impact.acknowledgement_text


def test_the_tombstone_directory_stays_inside_the_store(
    store: QuarantineStore, tmp_path: Path
) -> None:
    """A tombstone outside the store would be a cross-filesystem copy, not a
    rename — and an object briefly duplicated somewhere nobody is looking."""
    assert store.tombstone_root.parent == store.root
    assert store.tombstone_root.name.startswith(".")
    assert os.path.commonpath([store.root, store.tombstone_root]) == str(store.root)
