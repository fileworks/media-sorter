"""Startup classification of artifacts left behind by an interrupted operation.

Reconciliation reads what was authorized (the manifest) and how far execution
got (the journal), then measures what is actually on disk. It never guesses:
every classification is backed by a hash comparison, and the only artifact it
is ever allowed to delete is a stage whose content is already published at the
verified destination. Anything it cannot prove is preserved for the user.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.core.action_journal import (
    DurableActionJournal,
    JournalDurabilityError,
    journal_path,
    read_manifest,
    read_manifest_actions,
    unresolved_journals,
)
from app.core.events import EventRecorder, structlog_sink
from app.core.integrity import (
    ActionJournal,
    ActionStage,
    MutationManifest,
    MutationManifestAction,
)
from app.core.logging_config import get_logger
from app.services.verified_transfer import stream_sha256

logger = get_logger(__name__)

Classification = Literal[
    "completed",
    "redundant_verified_copies",
    "stage_recoverable",
    "resumable",
    "ambiguous",
]
RecoveryAction = Literal[
    "none",
    "remove_verified_source",
    "promote_stage",
    "retry",
    "manual_review",
]

#: Journal stages that prove the destination commit reached stable storage, and
#: therefore that removing the source was already authorized.
_COMMIT_PROVEN_STAGES: frozenset[ActionStage] = frozenset(
    {"committed", "journal_durable", "source_removing", "source_removed", "terminal"}
)


@dataclass(frozen=True)
class ActionReconciliation:
    action_id: str
    classification: Classification
    recommended: RecoveryAction
    source_path: Path
    destination_path: Path
    source_present: bool
    source_matches_manifest: bool
    destination_verified: bool
    destination_present: bool
    last_journal_stage: ActionStage | None
    verified_stages: tuple[Path, ...] = ()
    unverified_stages: tuple[Path, ...] = ()

    @property
    def has_verified_copy(self) -> bool:
        return (
            self.destination_verified or self.source_matches_manifest or bool(self.verified_stages)
        )


@dataclass(frozen=True)
class ReconciliationReport:
    journal_id: str
    manifest_id: str
    operation_id: str
    actions: tuple[ActionReconciliation, ...]

    @property
    def recovery_state(self) -> Literal["none", "available", "required"]:
        if any(item.classification == "ambiguous" for item in self.actions):
            return "required"
        if all(item.recommended == "none" for item in self.actions):
            return "none"
        return "available"


@dataclass
class RecoveryOutcome:
    manifest_id: str
    discarded_stages: list[Path] = field(default_factory=list)
    removed_sources: list[Path] = field(default_factory=list)
    unresolved_actions: list[str] = field(default_factory=list)
    journal_state: Literal["completed", "reconciliation_required"] = "completed"


def reconcile_pending_operations(root: Path) -> tuple[ReconciliationReport, ...]:
    """Classify every operation that never reached a terminal journal state."""
    reports: list[ReconciliationReport] = []
    for journal in unresolved_journals(root):
        actions = _authorized_actions(root, journal)
        if not actions:
            logger.warning(
                "Interrupted operation has no stored authorization; leaving artifacts untouched",
                manifest_id=journal.manifest_id,
                operation_id=journal.operation_id,
            )
            continue
        reports.append(reconcile_journal(journal, actions))
    return tuple(reports)


def _authorized_actions(
    root: Path,
    journal: ActionJournal,
) -> tuple[MutationManifestAction, ...]:
    """Read authorization from a whole manifest or a streaming action log."""
    manifest = read_manifest(root, journal.manifest_id)
    if manifest is not None:
        return manifest.actions
    return read_manifest_actions(root, journal.operation_id)


def reconcile_journal(
    journal: ActionJournal,
    actions: MutationManifest | Sequence[MutationManifestAction],
) -> ReconciliationReport:
    """Classify each authorized action against what survives on disk."""
    authorized = actions.actions if isinstance(actions, MutationManifest) else tuple(actions)
    last_stages = _last_stage_by_action(journal)
    return ReconciliationReport(
        journal_id=journal.journal_id,
        manifest_id=journal.manifest_id,
        operation_id=journal.operation_id,
        actions=tuple(
            _reconcile_action(action, last_stages.get(action.action_id)) for action in authorized
        ),
    )


def apply_safe_recovery(root: Path, report: ReconciliationReport) -> RecoveryOutcome:
    """Perform only the cleanup the evidence already justifies.

    A stage is discarded only when the destination independently hashes to the
    authorized content. A source is removed only when the destination is
    verified *and* the journal recorded the commit, so an interruption before
    that record leaves both copies for the user to decide about.
    """
    outcome = RecoveryOutcome(manifest_id=report.manifest_id)
    events = EventRecorder(report.operation_id, sink=structlog_sink(logger))
    events.emit(
        "recovery.scanned",
        phase="recovery",
        actions=len(report.actions),
        recovery_state=report.recovery_state,
    )
    path = journal_path(root, report.manifest_id)
    try:
        journal = DurableActionJournal.reopen(path)
    except (JournalDurabilityError, OSError, ValueError) as exc:
        logger.warning("Cannot reopen journal for recovery", journal=str(path), error=str(exc))
        outcome.journal_state = "reconciliation_required"
        outcome.unresolved_actions = [item.action_id for item in report.actions]
        return outcome

    with journal:
        for item in report.actions:
            journal.record(
                item.action_id,
                "reconciling",
                source_safety=_safety_of(item),
                diagnostic_code=item.classification,
            )
            if item.destination_verified:
                outcome.discarded_stages.extend(_discard(item.verified_stages))
                outcome.discarded_stages.extend(_discard(item.unverified_stages))
            if item.recommended == "remove_verified_source":
                _remove(item.source_path, outcome)
            elif item.recommended != "none":
                outcome.unresolved_actions.append(item.action_id)
            events.emit(
                "recovery.review_required"
                if item.recommended == "manual_review"
                else "recovery.reconciled",
                action_id=item.action_id,
                phase="recovery",
                classification=item.classification,
                recommended=item.recommended,
                destination_path=str(item.destination_path),
            )
            journal.record(
                item.action_id,
                "terminal",
                source_safety=_safety_of(item),
                diagnostic_code=item.classification,
            )
        outcome.journal_state = (
            "reconciliation_required" if outcome.unresolved_actions else "completed"
        )
        journal.finish(outcome.journal_state)
    events.conclude(
        "completed" if outcome.journal_state == "completed" else "partial",
        discarded_stages=len(outcome.discarded_stages),
        removed_sources=len(outcome.removed_sources),
    )
    return outcome


def _reconcile_action(
    action: MutationManifestAction,
    last_stage: ActionStage | None,
) -> ActionReconciliation:
    source = Path(action.source.observed_path)
    destination = Path(action.destination_path)
    source_present, source_matches = _content_state(source, action)
    destination_present, destination_verified = _content_state(destination, action)
    verified_stages, unverified_stages = _classify_stages(destination, action)
    removes_source = action.effects.source == "remove_after_verification"

    classification: Classification
    recommended: RecoveryAction
    if destination_verified:
        if removes_source and source_present:
            classification = "redundant_verified_copies"
            recommended = (
                "remove_verified_source" if last_stage in _COMMIT_PROVEN_STAGES else "manual_review"
            )
        else:
            classification = "completed"
            recommended = "none"
    elif destination_present:
        classification = "ambiguous"
        recommended = "manual_review"
    elif verified_stages:
        classification = "stage_recoverable"
        recommended = "promote_stage"
    elif source_matches:
        classification = "resumable"
        recommended = "retry"
    else:
        classification = "ambiguous"
        recommended = "manual_review"

    return ActionReconciliation(
        action_id=action.action_id,
        classification=classification,
        recommended=recommended,
        source_path=source,
        destination_path=destination,
        source_present=source_present,
        source_matches_manifest=source_matches,
        destination_present=destination_present,
        destination_verified=destination_verified,
        last_journal_stage=last_stage,
        verified_stages=verified_stages,
        unverified_stages=unverified_stages,
    )


def _content_state(path: Path, action: MutationManifestAction) -> tuple[bool, bool]:
    """Return ``(present, matches the authorized content)`` for one path."""
    try:
        if not path.is_file() or path.is_symlink():
            return path.exists() or path.is_symlink(), False
        if path.stat().st_size != action.expected_size_bytes:
            return True, False
        observed, _size = stream_sha256(path)
    except (OSError, ValueError):
        return path.exists(), False
    return True, observed == action.expected_sha256


def _classify_stages(
    destination: Path,
    action: MutationManifestAction,
) -> tuple[tuple[Path, ...], tuple[Path, ...]]:
    verified: list[Path] = []
    unverified: list[Path] = []
    try:
        candidates = sorted(destination.parent.glob(".*.ms-stage-*.tmp"))
    except OSError:
        return (), ()
    for candidate in candidates:
        _present, matches = _content_state(candidate, action)
        (verified if matches else unverified).append(candidate)
    return tuple(verified), tuple(unverified)


def _last_stage_by_action(journal: ActionJournal) -> dict[str, ActionStage]:
    stages: dict[str, ActionStage] = {}
    for entry in journal.entries:
        stages[entry.action_id] = entry.stage
    return stages


def _safety_of(
    item: ActionReconciliation,
) -> Literal[
    "destination_verified",
    "redundant_verified_copies",
    "source_retained",
    "ambiguous",
]:
    if item.destination_verified and item.source_present:
        return "redundant_verified_copies"
    if item.destination_verified:
        return "destination_verified"
    if item.source_matches_manifest:
        return "source_retained"
    return "ambiguous"


def _discard(stages: tuple[Path, ...]) -> list[Path]:
    discarded: list[Path] = []
    for stage in stages:
        try:
            stage.unlink()
        except OSError as exc:
            logger.warning("Could not discard redundant stage", stage=str(stage), error=str(exc))
            continue
        discarded.append(stage)
    return discarded


def _remove(source: Path, outcome: RecoveryOutcome) -> None:
    try:
        source.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        logger.warning("Could not remove verified source", source=str(source), error=str(exc))
        outcome.unresolved_actions.append(str(source))
        return
    outcome.removed_sources.append(source)
