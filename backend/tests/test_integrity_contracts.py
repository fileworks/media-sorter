"""Contract tests for immutable versioned integrity schemas."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.core.integrity import (
    ActionJournal,
    FilesystemMetadataSnapshot,
    IntegrityEvidence,
    IntegrityReport,
    JournalEntry,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    OperationEvent,
    OptimizationProfile,
    OutcomeCounts,
    PreservationProfile,
    SourceIdentity,
)

HASH = "a" * 64
NOW = datetime.now(timezone.utc)


def _source() -> SourceIdentity:
    return SourceIdentity(
        root_id="input-1",
        relative_path="album/photo.jpg",
        observed_path="/media/album/photo.jpg",
        file_id="42",
        sha256=HASH,
        metadata=FilesystemMetadataSnapshot(
            size_bytes=123,
            mtime_ns=1_700_000_000_000_000_000,
            atime_ns=1_700_000_000_000_000_000,
        ),
    )


def _action(action_id: str = "action-1") -> MutationManifestAction:
    return MutationManifestAction(
        action_id=action_id,
        kind="move",
        source=_source(),
        destination_path="/sorted/2024/photo.jpg",
        expected_sha256=HASH,
        expected_size_bytes=123,
        effects=MutationEffects(
            source="remove_after_verification",
        ),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )


def test_organize_only_is_immutable_and_forbids_mutation_permissions() -> None:
    profile = PreservationProfile()
    assert profile.mode == "organize_only"
    assert profile.allow_embedded_metadata_edits is False
    assert profile.allow_repair is False
    assert profile.allow_conversion is False
    assert profile.allow_compression is False
    assert profile.preserve_filesystem_timestamps is True
    with pytest.raises(ValidationError):
        PreservationProfile(mode="organize_only", allow_repair=True)
    with pytest.raises(ValidationError):
        profile.name = "Changed"  # type: ignore[misc]


def test_pending_migrated_mutation_profile_is_representable_but_not_acknowledged() -> None:
    profile = PreservationProfile(
        profile_id="legacy-mutation-review",
        name="Review previous modifying settings",
        mode="explicit_mutation",
        allow_repair=True,
        authorization_origin="migration",
        requires_review=True,
    )
    assert profile.acknowledged_at is None
    assert profile.requires_review is True


def test_enabled_optimization_requires_acknowledgement_and_reproducible_contract() -> None:
    with pytest.raises(ValidationError):
        OptimizationProfile(mode="lossless")

    profile = OptimizationProfile(
        profile_id="lossless-v1",
        name="Lossless",
        mode="lossless",
        acknowledged_at=NOW,
        tool="ffmpeg",
        tool_version="7.1",
        parameters={"codec": "ffv1"},
        validation_contract="video-lossless-v1",
    )
    assert profile.retain_original is True


def test_manifest_actions_are_immutable_unique_and_bound_to_source_evidence() -> None:
    action = _action()
    manifest = MutationManifest(
        manifest_id="manifest-1",
        operation_id="operation-1",
        plan_id="plan-1",
        profile_id="library-1",
        effective_config_sha256="b" * 64,
        actions=(action,),
    )
    assert manifest.schema_version == 1
    assert manifest.actions[0].expected_sha256 == HASH

    with pytest.raises(ValidationError):
        MutationManifest(
            manifest_id="manifest-1",
            operation_id="operation-1",
            plan_id="plan-1",
            profile_id="library-1",
            effective_config_sha256="b" * 64,
            actions=(action, action),
        )
    with pytest.raises(ValidationError):
        _action().model_copy(update={"expected_size_bytes": 124}).model_validate(
            {
                **_action().model_dump(),
                "expected_size_bytes": 124,
            }
        )


def test_verified_integrity_evidence_requires_matching_hashes_sizes_and_time() -> None:
    evidence = IntegrityEvidence(
        expected_sha256=HASH,
        observed_source_sha256=HASH,
        observed_result_sha256=HASH,
        expected_size_bytes=123,
        observed_source_size_bytes=123,
        observed_result_size_bytes=123,
        verified=True,
        verified_at=NOW,
    )
    assert evidence.verified is True

    with pytest.raises(ValidationError):
        IntegrityEvidence(
            expected_sha256=HASH,
            observed_source_sha256=HASH,
            observed_result_sha256="c" * 64,
            expected_size_bytes=123,
            observed_source_size_bytes=123,
            observed_result_size_bytes=123,
            verified=True,
            verified_at=NOW,
        )


def test_journal_sequences_are_contiguous() -> None:
    first = JournalEntry(
        sequence=1,
        action_id="action-1",
        stage="planned",
        source_safety="source_retained",
    )
    journal = ActionJournal(
        journal_id="journal-1",
        manifest_id="manifest-1",
        operation_id="operation-1",
        entries=(first,),
    )
    assert journal.entries == (first,)

    with pytest.raises(ValidationError):
        ActionJournal(
            journal_id="journal-1",
            manifest_id="manifest-1",
            operation_id="operation-1",
            entries=(
                first,
                JournalEntry(
                    sequence=3,
                    action_id="action-1",
                    stage="staging",
                    source_safety="source_retained",
                ),
            ),
        )


def test_event_and_report_contracts_are_versioned_and_ordered() -> None:
    event = OperationEvent(
        sequence=1,
        event_code="operation.preflight.started",
        severity="info",
        operation_id="operation-1",
        task_id="task-1",
        plan_id="plan-1",
        message_key="operation.preflight.started",
    )
    assert event.schema_version == 1

    report = IntegrityReport(
        report_id="report-1",
        operation_id="operation-1",
        manifest_id="manifest-1",
        profile_id="library-1",
        started_at=NOW,
        finished_at=NOW,
        outcome="completed",
        counts=OutcomeCounts(verified_success=1),
        bytes_read=123,
        bytes_written=123,
        actions=(),
    )
    assert report.schema_version == 1

    with pytest.raises(ValidationError):
        IntegrityReport(
            **{
                **report.model_dump(),
                "started_at": NOW,
                "finished_at": datetime(2000, 1, 1, tzinfo=timezone.utc),
            }
        )
