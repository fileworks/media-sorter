"""Tests for the durable append-only action journal."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from app.core.action_journal import (
    DurableActionJournal,
    JournalDurabilityError,
    list_journals,
    read_journal,
    unresolved_journals,
)
from app.core.integrity import (
    FilesystemMetadataSnapshot,
    IntegrityEvidence,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceIdentity,
)

_ZERO_DIGEST = hashlib.sha256(b"").hexdigest()


def _manifest(manifest_id: str = "manifest-1") -> MutationManifest:
    action = MutationManifestAction(
        action_id="action-1",
        kind="move",
        source=SourceIdentity(
            root_id="input-1",
            relative_path="a.bin",
            observed_path="/library/a.bin",
            sha256=_ZERO_DIGEST,
            metadata=FilesystemMetadataSnapshot(size_bytes=0, mtime_ns=1, atime_ns=1),
        ),
        destination_path="/sorted/a.bin",
        expected_sha256=_ZERO_DIGEST,
        expected_size_bytes=0,
        effects=MutationEffects(source="remove_after_verification"),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )
    return MutationManifest(
        manifest_id=manifest_id,
        operation_id="operation-1",
        plan_id="plan-1",
        profile_id="organize-only",
        effective_config_sha256=_ZERO_DIGEST,
        actions=(action,),
    )


def _evidence() -> IntegrityEvidence:
    return IntegrityEvidence(
        expected_sha256=_ZERO_DIGEST,
        observed_source_sha256=_ZERO_DIGEST,
        observed_result_sha256=_ZERO_DIGEST,
        expected_size_bytes=0,
        observed_source_size_bytes=0,
        observed_result_size_bytes=0,
    )


def test_every_record_is_flushed_and_fsynced_before_returning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    synced: list[int] = []
    real_fsync = os.fsync

    def observe_fsync(descriptor: int) -> None:
        synced.append(descriptor)
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", observe_fsync)

    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        before = len(synced)
        journal.record("action-1", "committed", source_safety="destination_verified")
        assert len(synced) > before

    assert len(list_journals(tmp_path)) == 1


def test_journal_round_trips_header_entries_and_terminal_state(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        journal.record("action-1", "staged", source_safety="source_retained")
        journal.record(
            "action-1",
            "committed",
            source_safety="redundant_verified_copies",
            integrity=_evidence(),
        )
        journal.finish("completed")

    stored = read_journal(list_journals(tmp_path)[0])

    assert stored.manifest_id == "manifest-1"
    assert stored.operation_id == "operation-1"
    assert stored.state == "completed"
    assert [entry.sequence for entry in stored.entries] == [1, 2]
    assert [entry.stage for entry in stored.entries] == ["staged", "committed"]
    assert stored.entries[1].integrity is not None
    assert stored.entries[1].integrity.expected_sha256 == _ZERO_DIGEST


def test_interrupted_journal_stays_active_and_is_reported_unresolved(tmp_path: Path) -> None:
    journal = DurableActionJournal.open(tmp_path, _manifest())
    journal.record("action-1", "committed", source_safety="redundant_verified_copies")
    journal.close()  # power loss: no terminal record was ever written

    stored = read_journal(list_journals(tmp_path)[0])

    assert stored.state == "active"
    assert [item.journal_id for item in unresolved_journals(tmp_path)] == ["manifest-1"]


def test_completed_journals_are_not_reported_unresolved(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        journal.record("action-1", "terminal", source_safety="destination_verified")

    assert unresolved_journals(tmp_path) == ()


def test_crash_truncated_last_record_is_discarded(tmp_path: Path) -> None:
    journal = DurableActionJournal.open(tmp_path, _manifest())
    journal.record("action-1", "staged", source_safety="source_retained")
    journal.close()
    path = list_journals(tmp_path)[0]
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"record":"entry","sequence":2,"acti')

    stored = read_journal(path)

    assert [entry.sequence for entry in stored.entries] == [1]


def test_corrupt_interior_record_is_not_silently_dropped(tmp_path: Path) -> None:
    journal = DurableActionJournal.open(tmp_path, _manifest())
    journal.record("action-1", "staged", source_safety="source_retained")
    journal.close()
    path = list_journals(tmp_path)[0]
    lines = path.read_text(encoding="utf-8").splitlines()
    lines.insert(1, "{ this is not json")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="Corrupt action journal record"):
        read_journal(path)


def test_failed_operation_is_recorded_as_failed(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="execution exploded"):
        with DurableActionJournal.open(tmp_path, _manifest()) as journal:
            journal.record("action-1", "staging", source_safety="source_retained")
            raise RuntimeError("execution exploded")

    assert read_journal(list_journals(tmp_path)[0]).state == "failed"


def test_terminal_journal_rejects_further_entries(tmp_path: Path) -> None:
    journal = DurableActionJournal.open(tmp_path, _manifest())
    journal.finish("cancelled")

    with pytest.raises(JournalDurabilityError):
        journal.record("action-1", "staged", source_safety="source_retained")

    journal.close()


def test_non_terminal_finish_state_is_rejected(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        with pytest.raises(ValueError, match="not a terminal journal state"):
            journal.finish("active")


def test_manifest_identity_is_recorded_in_the_header(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        path = journal.path

    header = json.loads(path.read_text(encoding="utf-8").splitlines()[0])

    assert header["record"] == "header"
    assert header["plan_id"] == "plan-1"
    assert header["profile_id"] == "organize-only"
    assert header["action_ids"] == ["action-1"]


def test_journal_file_name_is_filesystem_safe(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest("op/1:2\\3")) as journal:
        name = journal.path.name

    assert name == "op-1-2-3.journal.jsonl"
    assert journal.last_stage("action-1") is None


def test_unreadable_journals_do_not_break_reconciliation_scanning(tmp_path: Path) -> None:
    with DurableActionJournal.open(tmp_path, _manifest()) as journal:
        journal.record("action-1", "staged", source_safety="source_retained")
    (tmp_path / "journals" / "broken.journal.jsonl").write_text("not json\n", encoding="utf-8")

    assert unresolved_journals(tmp_path) == ()
