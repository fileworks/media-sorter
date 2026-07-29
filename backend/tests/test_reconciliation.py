"""Tests for startup reconciliation of interrupted mutation operations."""

from __future__ import annotations

import hashlib
import stat
from pathlib import Path

import pytest

from app.core.action_journal import (
    DurableActionJournal,
    journal_path,
    manifest_path,
    read_journal,
    store_manifest,
)
from app.core.bootstrap import _reconcile_interrupted_operations
from app.core.integrity import (
    ActionStage,
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceEffect,
    SourceIdentity,
)
from app.core.logging_config import get_logger
from app.services import verified_transfer
from app.services.reconciliation import (
    apply_safe_recovery,
    reconcile_pending_operations,
)


def _manifest(
    source: Path,
    destination: Path,
    *,
    source_effect: SourceEffect = "remove_after_verification",
    manifest_id: str = "manifest-1",
) -> MutationManifest:
    observed = source.stat()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    action = MutationManifestAction(
        action_id="action-1",
        kind="move" if source_effect == "remove_after_verification" else "copy",
        source=SourceIdentity(
            root_id="input-1",
            relative_path=source.name,
            observed_path=str(source),
            sha256=digest,
            metadata=FilesystemMetadataSnapshot(
                size_bytes=observed.st_size,
                mtime_ns=observed.st_mtime_ns,
                atime_ns=observed.st_atime_ns,
                mode=stat.S_IMODE(observed.st_mode),
            ),
        ),
        destination_path=str(destination),
        expected_sha256=digest,
        expected_size_bytes=observed.st_size,
        effects=MutationEffects(source=source_effect),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )
    return MutationManifest(
        manifest_id=manifest_id,
        operation_id="operation-1",
        plan_id="plan-1",
        profile_id="organize-only",
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        actions=(action,),
    )


def _interrupt(root: Path, manifest: MutationManifest, stages: tuple[ActionStage, ...]) -> None:
    """Write a journal that stops after ``stages`` with no terminal record."""
    journal = DurableActionJournal.open(root, manifest)
    for stage in stages:
        journal.record("action-1", stage, source_safety="source_retained")
    journal.close()


def test_manifest_is_stored_when_the_journal_opens(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"stored authorization")
    manifest = _manifest(source, tmp_path / "sorted" / "source.bin")

    with DurableActionJournal.open(tmp_path / "state", manifest):
        pass

    assert manifest_path(tmp_path / "state", "manifest-1").is_file()


def test_stored_manifests_are_never_rewritten(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"first authorization")
    root = tmp_path / "state"
    store_manifest(root, _manifest(source, tmp_path / "a.bin"))
    original = manifest_path(root, "manifest-1").read_text(encoding="utf-8")

    source.write_bytes(b"second authorization!")
    store_manifest(root, _manifest(source, tmp_path / "b.bin"))

    assert manifest_path(root, "manifest-1").read_text(encoding="utf-8") == original


def test_crash_after_commit_reports_a_safe_redundant_state(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"power loss after commit")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("staging", "staged", "committed", "journal_durable"))

    (report,) = reconcile_pending_operations(root)

    assert report.recovery_state == "available"
    (item,) = report.actions
    assert item.classification == "redundant_verified_copies"
    assert item.recommended == "remove_verified_source"
    assert item.has_verified_copy


def test_recovery_completes_the_record_without_repeating_the_transfer(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"finish the record")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("committed", "journal_durable", "source_removing"))

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert outcome.removed_sources == [source]
    assert outcome.unresolved_actions == []
    assert outcome.journal_state == "completed"
    assert source.exists() is False
    assert destination.read_bytes() == b"finish the record"
    assert read_journal(journal_path(root, "manifest-1")).state == "completed"
    assert reconcile_pending_operations(root) == ()


def test_commit_without_journal_evidence_is_never_cleaned_up_automatically(
    tmp_path: Path,
) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"no commit record")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("staging", "staged", "committing"))

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert report.actions[0].recommended == "manual_review"
    assert outcome.removed_sources == []
    assert outcome.journal_state == "reconciliation_required"
    assert source.exists()
    assert destination.exists()


def test_interruption_before_any_write_is_resumable(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"nothing happened yet")
    _interrupt(root, _manifest(source, destination), ("authorized",))

    (report,) = reconcile_pending_operations(root)

    assert report.actions[0].classification == "resumable"
    assert report.actions[0].recommended == "retry"


def test_orphaned_verified_stage_is_offered_for_promotion_not_deleted(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"staged but never published")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    stage = destination.parent / ".source.ms-stage-abc123.tmp"
    stage.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("staging", "staged", "integrity_verified"))

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert report.actions[0].classification == "stage_recoverable"
    assert report.actions[0].verified_stages == (stage,)
    assert outcome.discarded_stages == []
    assert stage.exists(), "an unpublished verified copy must survive reconciliation"


def test_redundant_stage_is_discarded_once_the_destination_is_verified(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"stage is now redundant")
    manifest = _manifest(source, destination, source_effect="retained")
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    stage = destination.parent / ".source.ms-stage-def456.tmp"
    stage.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("committed", "journal_durable"))

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert report.actions[0].classification == "completed"
    assert outcome.discarded_stages == [stage]
    assert stage.exists() is False
    assert destination.read_bytes() == b"stage is now redundant"
    assert source.exists()


def test_unexpected_destination_content_is_preserved_for_review(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"authorized content")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"somebody else's file")
    _interrupt(root, manifest, ("staging", "committing"))

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert report.recovery_state == "required"
    assert report.actions[0].classification == "ambiguous"
    assert outcome.journal_state == "reconciliation_required"
    assert destination.read_bytes() == b"somebody else's file"
    assert source.read_bytes() == b"authorized content"


def test_startup_exposes_unresolved_artifacts_for_the_shell(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"authorized content")
    manifest = _manifest(source, destination)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"unexpected content")
    _interrupt(root, manifest, ("staging", "committing"))

    operation_ids, operations = _reconcile_interrupted_operations(
        get_logger("recovery-test"),
        root,
    )

    assert operation_ids == ["operation-1"]
    assert operations[0]["state"] == "reconciliation_required"
    artifacts = operations[0]["artifacts"]
    assert isinstance(artifacts, list)
    assert {item["kind"] for item in artifacts} == {"original", "result"}
    assert any(not item["verified"] for item in artifacts)


def test_lost_content_is_reported_rather_than_silently_completed(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"content that vanished")
    manifest = _manifest(source, destination)
    _interrupt(root, manifest, ("staging",))
    source.unlink()

    (report,) = reconcile_pending_operations(root)

    assert report.actions[0].classification == "ambiguous"
    assert report.actions[0].has_verified_copy is False
    assert report.recovery_state == "required"


def test_an_interrupted_real_transfer_reconciles_to_a_redundant_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"real transfer, real crash")
    manifest = _manifest(source, destination)
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def crash(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt("power loss before source removal")

    journal = DurableActionJournal.open(root, manifest)
    monkeypatch.setattr(verified_transfer, "_remove_verified_source", crash)
    with pytest.raises(KeyboardInterrupt):
        verified_transfer.execute_transfer(manifest.actions[0], journal=journal)
    journal.close()
    monkeypatch.undo()

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert report.actions[0].classification == "redundant_verified_copies"
    assert outcome.removed_sources == [source]
    assert source.exists() is False
    assert destination.read_bytes() == b"real transfer, real crash"


def test_missing_manifest_leaves_artifacts_untouched(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    source.write_bytes(b"no authorization on disk")
    manifest = _manifest(source, tmp_path / "sorted" / "source.bin")
    _interrupt(root, manifest, ("staging",))
    manifest_path(root, "manifest-1").unlink()

    assert reconcile_pending_operations(root) == ()
    assert source.exists()


def test_recovery_appends_to_a_crash_truncated_journal(tmp_path: Path) -> None:
    root = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "source.bin"
    source.write_bytes(b"truncated journal")
    manifest = _manifest(source, destination, source_effect="retained")
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    _interrupt(root, manifest, ("committed",))
    with journal_path(root, "manifest-1").open("a", encoding="utf-8") as handle:
        handle.write('{"record":"entry","sequence":2,"acti')

    (report,) = reconcile_pending_operations(root)
    outcome = apply_safe_recovery(root, report)

    assert outcome.journal_state == "completed"
    stored = read_journal(journal_path(root, "manifest-1"))
    assert stored.state == "completed"
    assert [entry.sequence for entry in stored.entries] == [1, 2, 3]
