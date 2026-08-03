"""Versioned integrity, mutation, journal, outcome, event, and report contracts.

These models are presentation-neutral and immutable. Execution code may only
consume a fully validated :class:`MutationManifest`; it must never reconstruct
authorization by inspecting unrelated configuration booleans.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from app.core.media_units import CompanionRole
from app.core.provenance import OutcomeProvenance

INTEGRITY_SCHEMA_VERSION: Literal[1] = 1
PRESERVATION_PROFILE_VERSION: Literal[1] = 1
OPTIMIZATION_PROFILE_VERSION: Literal[1] = 1
MANIFEST_SCHEMA_VERSION: Literal[1] = 1
JOURNAL_SCHEMA_VERSION: Literal[1] = 1
EVENT_SCHEMA_VERSION: Literal[1] = 1
REPORT_SCHEMA_VERSION: Literal[1] = 1

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
PreservationMode = Literal["organize_only", "explicit_mutation"]
OptimizationMode = Literal["disabled", "lossless", "visually_lossless"]
AuthorizationOrigin = Literal["default", "migration", "saved_profile", "run_override"]
MutationActionKind = Literal[
    "copy",
    "move",
    "quarantine",
    "restore",
    "replace",
    "rename",
    "sidecar_create",
    "sidecar_update",
]
ContentEffect = Literal[
    "unchanged",
    "remuxed",
    "losslessly_encoded",
    "lossy_encoded",
]
EmbeddedMetadataEffect = Literal["preserved", "added", "changed", "removed", "unknown"]
SidecarEffect = Literal["none", "create", "update"]
SourceEffect = Literal["retained", "renamed", "remove_after_verification"]
JournalState = Literal["active", "completed", "cancelled", "failed", "reconciliation_required"]
ActionStage = Literal[
    "planned",
    "authorized",
    "staging",
    "staged",
    "integrity_verifying",
    "integrity_verified",
    "metadata_applying",
    "committing",
    "committed",
    "journal_durable",
    "source_removing",
    "source_removed",
    "reconciling",
    "terminal",
]
OutcomeCode = Literal[
    "verified_success",
    "success_with_metadata_limitation",
    "skipped",
    # Review excluded this source from the run. Distinct from "skipped", which
    # is the pipeline's own decision, so a report can state the two separately.
    "excluded",
    "quarantined",
    "cancelled",
    "blocked",
    "partial",
    "failed",
    "integrity_failed",
    "incomplete_unit",
    "reconciliation_required",
]
OperationOutcomeCode = Literal[
    "completed",
    "completed_with_warnings",
    "partial",
    "cancelled",
    "failed",
]
Severity = Literal["debug", "info", "warning", "error", "critical"]
PrivacyClass = Literal["public", "operational", "path", "media_metadata", "secret"]
SourceSafetyState = Literal[
    "source_verified",
    "source_retained",
    "destination_verified",
    "redundant_verified_copies",
    "ambiguous",
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PreservationProfile(BaseModel):
    """Authorization contract for media-preserving organization."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = PRESERVATION_PROFILE_VERSION
    profile_id: str = Field(default="organize-only", min_length=1, max_length=128)
    name: str = Field(default="Organize Only", min_length=1, max_length=200)
    mode: PreservationMode = "organize_only"
    allow_embedded_metadata_edits: bool = False
    allow_repair: bool = False
    allow_conversion: bool = False
    allow_compression: bool = False
    preserve_filesystem_timestamps: bool = True
    derived_metadata: Literal["report_only", "sidecar_and_report"] = "report_only"
    authorization_origin: AuthorizationOrigin = "default"
    acknowledged_at: datetime | None = None
    requires_review: bool = False

    @model_validator(mode="after")
    def organize_only_forbids_media_mutation(self) -> PreservationProfile:
        modifying = (
            self.allow_embedded_metadata_edits
            or self.allow_repair
            or self.allow_conversion
            or self.allow_compression
        )
        if self.mode == "organize_only" and modifying:
            raise ValueError("Organize Only cannot authorize media mutation")
        if (
            self.mode == "explicit_mutation"
            and modifying
            and self.acknowledged_at is None
            and not self.requires_review
        ):
            raise ValueError("explicit mutation profiles require acknowledgement or pending review")
        return self


class OptimizationProfile(BaseModel):
    """Explicit, reproducible authorization for derived optimized outputs."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = OPTIMIZATION_PROFILE_VERSION
    profile_id: str = Field(default="optimization-disabled", min_length=1, max_length=128)
    name: str = Field(default="Optimization disabled", min_length=1, max_length=200)
    mode: OptimizationMode = "disabled"
    acknowledged_at: datetime | None = None
    tool: str | None = None
    tool_version: str | None = None
    parameters: dict[str, JsonValue] = Field(default_factory=dict)
    validation_contract: str | None = None
    memory_limit_mib: int = Field(default=512, ge=128)
    temporary_space_limit_bytes: int | None = Field(default=None, ge=1)
    retain_original: bool = True

    @model_validator(mode="after")
    def enabled_profile_is_reviewed_and_reproducible(self) -> OptimizationProfile:
        if self.mode == "disabled":
            if self.acknowledged_at is not None or self.tool is not None or self.parameters:
                raise ValueError("disabled optimization cannot carry execution authorization")
            return self
        if self.acknowledged_at is None:
            raise ValueError("enabled optimization requires explicit acknowledgement")
        if not self.tool or not self.tool_version or not self.validation_contract:
            raise ValueError("enabled optimization requires tool and validation versions")
        if not self.retain_original:
            raise ValueError("enabled optimization must retain the original")
        return self


class FilesystemMetadataSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    size_bytes: int = Field(ge=0)
    mtime_ns: int
    atime_ns: int
    mode: int | None = Field(default=None, ge=0)
    attributes: dict[str, JsonValue] = Field(default_factory=dict)


class SourceIdentity(BaseModel):
    model_config = ConfigDict(frozen=True)

    root_id: str = Field(min_length=1, max_length=128)
    relative_path: str = Field(min_length=1)
    observed_path: str = Field(min_length=1)
    file_id: str | None = None
    sha256: Sha256
    metadata: FilesystemMetadataSnapshot


class MutationEffects(BaseModel):
    model_config = ConfigDict(frozen=True)

    content: ContentEffect = "unchanged"
    embedded_metadata: EmbeddedMetadataEffect = "preserved"
    sidecar: SidecarEffect = "none"
    filesystem_timestamps: Literal["preserve", "change", "best_effort"] = "preserve"
    source: SourceEffect


class MutationManifestAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = MANIFEST_SCHEMA_VERSION
    action_id: str = Field(min_length=1, max_length=128)
    kind: MutationActionKind
    source: SourceIdentity
    destination_path: str = Field(min_length=1)
    quarantine_path: str | None = None
    expected_sha256: Sha256
    expected_size_bytes: int = Field(ge=0)
    effects: MutationEffects
    preservation_profile_id: str = Field(min_length=1, max_length=128)
    preservation_profile_version: int = Field(ge=1)
    optimization_profile_id: str | None = None
    rule_version: str | None = None
    authorization_origin: AuthorizationOrigin
    unit_id: str | None = None
    companion_role: CompanionRole | None = None
    unit_primary_path: str | None = None
    provenance: OutcomeProvenance | None = None

    @model_validator(mode="after")
    def expected_content_matches_observed_source(self) -> MutationManifestAction:
        if self.expected_sha256 != self.source.sha256:
            raise ValueError("expected hash must match the authorized source identity")
        if self.expected_size_bytes != self.source.metadata.size_bytes:
            raise ValueError("expected size must match the authorized source identity")
        return self


class MutationManifest(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = MANIFEST_SCHEMA_VERSION
    manifest_id: str = Field(min_length=1, max_length=128)
    operation_id: str = Field(min_length=1, max_length=128)
    plan_id: str = Field(min_length=1, max_length=128)
    profile_id: str = Field(min_length=1, max_length=128)
    effective_config_sha256: Sha256
    created_at: datetime = Field(default_factory=utc_now)
    actions: tuple[MutationManifestAction, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def action_ids_are_unique(self) -> MutationManifest:
        action_ids = [action.action_id for action in self.actions]
        if len(action_ids) != len(set(action_ids)):
            raise ValueError("manifest action ids must be unique")
        return self


class IntegrityEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = INTEGRITY_SCHEMA_VERSION
    algorithm: Literal["sha256"] = "sha256"
    expected_sha256: Sha256
    observed_source_sha256: Sha256
    observed_result_sha256: Sha256 | None = None
    expected_size_bytes: int = Field(ge=0)
    observed_source_size_bytes: int = Field(ge=0)
    observed_result_size_bytes: int | None = Field(default=None, ge=0)
    verified: bool = False
    verified_at: datetime | None = None

    @model_validator(mode="after")
    def verified_evidence_is_complete(self) -> IntegrityEvidence:
        if self.verified:
            if self.verified_at is None or self.observed_result_sha256 is None:
                raise ValueError("verified integrity evidence requires result hash and time")
            if not (
                self.expected_sha256 == self.observed_source_sha256 == self.observed_result_sha256
            ):
                raise ValueError("verified integrity hashes must be identical")
            if not (
                self.expected_size_bytes
                == self.observed_source_size_bytes
                == self.observed_result_size_bytes
            ):
                raise ValueError("verified integrity sizes must be identical")
        return self


class QualityEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = INTEGRITY_SCHEMA_VERSION
    contract_id: str = Field(min_length=1, max_length=200)
    decoded_successfully: bool
    measurements: dict[str, float | int | str | bool | None] = Field(default_factory=dict)
    thresholds: dict[str, float | int | str | bool | None] = Field(default_factory=dict)
    sampling_scope: str | None = None
    passed: bool | None = None
    warnings: tuple[str, ...] = ()


class JournalEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    sequence: int = Field(ge=1)
    action_id: str = Field(min_length=1, max_length=128)
    stage: ActionStage
    recorded_at: datetime = Field(default_factory=utc_now)
    staged_path: str | None = None
    integrity: IntegrityEvidence | None = None
    source_safety: SourceSafetyState
    diagnostic_code: str | None = None


class ActionJournal(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = JOURNAL_SCHEMA_VERSION
    journal_id: str = Field(min_length=1, max_length=128)
    manifest_id: str = Field(min_length=1, max_length=128)
    operation_id: str = Field(min_length=1, max_length=128)
    state: JournalState = "active"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    entries: tuple[JournalEntry, ...] = ()

    @model_validator(mode="after")
    def journal_sequences_are_strictly_ordered(self) -> ActionJournal:
        sequences = [entry.sequence for entry in self.entries]
        if sequences != list(range(1, len(sequences) + 1)):
            raise ValueError("journal entry sequences must be contiguous and ordered")
        return self


class ActionOutcome(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = REPORT_SCHEMA_VERSION
    action_id: str = Field(min_length=1, max_length=128)
    code: OutcomeCode
    source_safety: SourceSafetyState
    source_path: str
    result_path: str | None = None
    integrity: IntegrityEvidence | None = None
    quality: QualityEvidence | None = None
    commit_method: Literal[
        "none",
        "atomic_rename",
        "staged_atomic_promote",
        "recoverable_non_atomic",
    ] = "none"
    filesystem_metadata_requested: FilesystemMetadataSnapshot | None = None
    filesystem_metadata_observed: FilesystemMetadataSnapshot | None = None
    warnings: tuple[str, ...] = ()
    diagnostic_code: str | None = None


class OperationEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = EVENT_SCHEMA_VERSION
    sequence: int = Field(ge=1)
    event_code: str = Field(min_length=1, max_length=160)
    severity: Severity
    privacy: PrivacyClass = "operational"
    operation_id: str = Field(min_length=1, max_length=128)
    task_id: str | None = None
    plan_id: str | None = None
    action_id: str | None = None
    profile_id: str | None = None
    root_id: str | None = None
    phase: str | None = None
    occurred_at: datetime = Field(default_factory=utc_now)
    message_key: str = Field(min_length=1, max_length=200)
    context: dict[str, JsonValue] = Field(default_factory=dict)


class OutcomeCounts(BaseModel):
    model_config = ConfigDict(frozen=True)

    verified_success: int = Field(default=0, ge=0)
    warnings: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    quarantined: int = Field(default=0, ge=0)
    cancelled: int = Field(default=0, ge=0)
    blocked: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)
    unresolved: int = Field(default=0, ge=0)


class IntegrityReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = REPORT_SCHEMA_VERSION
    report_id: str = Field(min_length=1, max_length=128)
    operation_id: str = Field(min_length=1, max_length=128)
    manifest_id: str = Field(min_length=1, max_length=128)
    profile_id: str = Field(min_length=1, max_length=128)
    started_at: datetime
    finished_at: datetime
    outcome: OperationOutcomeCode
    counts: OutcomeCounts
    bytes_read: int = Field(ge=0)
    bytes_written: int = Field(ge=0)
    actions: tuple[ActionOutcome, ...]
    warnings: tuple[str, ...] = ()
    recovery_state: Literal["none", "available", "required"] = "none"

    @model_validator(mode="after")
    def report_time_is_ordered(self) -> IntegrityReport:
        if self.finished_at < self.started_at:
            raise ValueError("report finish time cannot precede start time")
        return self
