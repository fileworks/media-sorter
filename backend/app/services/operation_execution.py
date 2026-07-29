"""Per-operation binding of manifest authorization, journal, and outcomes.

One of these exists for the lifetime of a sort. It is the only place that knows
how a placement becomes an authorized, journalled, verified action, so no
pipeline step can move media by any other route.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.core.action_journal import DurableActionJournal, JournalDurabilityError
from app.core.events import EventRecorder, structlog_sink
from app.core.exceptions import MutationPolicyError
from app.core.integrity import (
    ActionOutcome,
    IntegrityReport,
    MutationActionKind,
    OperationOutcomeCode,
    OutcomeCounts,
    PreservationProfile,
    SidecarEffect,
    utc_now,
)
from app.core.integrity_policy import MutationAuthorization
from app.core.logging_config import get_logger
from app.core.media_units import CompanionRole
from app.core.provenance import OutcomeProvenance
from app.core.sort_plan import FrozenPlanGuard, FrozenSortPlan
from app.services.mutation_planner import build_placement_action
from app.services.verified_transfer import TransferResult, execute_transfer

logger = get_logger(__name__)

REPORT_DIRECTORY_NAME = "reports"
REPORT_SUFFIX = ".integrity.json"


@dataclass
class OperationExecution:
    """Authorizes, journals, and verifies every media placement of one run."""

    operation_id: str
    state_root: Path
    preservation: PreservationProfile
    authorization: MutationAuthorization
    journal: DurableActionJournal | None = None
    events: EventRecorder | None = None
    #: Roots the user marked comparison-only. Nothing inside one may ever be
    #: read *from* as a source or written *to* as a destination.
    protected_roots: tuple[Path, ...] = ()
    frozen_plan: FrozenSortPlan | None = None
    plan_guard: FrozenPlanGuard | None = None
    outcomes: list[ActionOutcome] = field(default_factory=list)
    bytes_read: int = 0
    bytes_written: int = 0
    started_at: object = field(default_factory=utc_now)

    @classmethod
    def start(
        cls,
        *,
        operation_id: str,
        state_root: Path,
        preservation: PreservationProfile,
        authorization: MutationAuthorization,
        effective_config_sha256: str,
        protected_roots: Sequence[Path] = (),
        frozen_plan: FrozenSortPlan | None = None,
    ) -> OperationExecution:
        """Open the durable record, degrading to unjournalled execution safely.

        A journal that cannot be created is a real problem, but it is not a
        reason to refuse to organize media: verification still happens on every
        byte. The degradation is logged as a warning so it is visible.
        """
        execution = cls(
            operation_id=operation_id,
            state_root=state_root,
            preservation=preservation,
            authorization=authorization,
            protected_roots=tuple(protected_roots),
            frozen_plan=frozen_plan,
            plan_guard=FrozenPlanGuard(frozen_plan) if frozen_plan is not None else None,
            events=EventRecorder(
                operation_id,
                plan_id=operation_id,
                profile_id=preservation.profile_id,
                sink=structlog_sink(logger),
            ),
        )
        execution.emit("operation.started", phase="validating")
        execution.emit(
            "operation.authorized",
            phase="validating",
            preservation_mode=preservation.mode,
            requested=sorted(authorization.requested),
        )
        try:
            execution.journal = DurableActionJournal.open_operation(
                state_root,
                operation_id=operation_id,
                plan_id=operation_id,
                profile_id=preservation.profile_id,
                effective_config_sha256=effective_config_sha256,
            )
        except (JournalDurabilityError, OSError) as exc:
            logger.warning(
                "Operation is running without a durable action journal",
                operation_id=operation_id,
                error=str(exc),
            )
            execution.emit("logging.degraded", reason="action_journal_unavailable")
        return execution

    def emit(self, code: str, **fields: Any) -> None:
        """Record one correlated event, never letting telemetry break the run."""
        if self.events is None:
            return
        try:
            self.events.emit(code, **fields)
        except Exception as exc:  # pragma: no cover - observability is not critical path
            logger.debug("Event not recorded", code=code, error=str(exc))

    def finish(self, outcome: OperationOutcomeCode) -> None:
        if self.events is not None and self.events.terminal is None:
            try:
                self.events.conclude(
                    outcome,
                    actions=len(self.outcomes),
                    bytes_written=self.bytes_written,
                )
            except Exception as exc:  # pragma: no cover
                logger.debug("Terminal event not recorded", error=str(exc))
        if self.journal is None:
            return
        try:
            self.journal.finish(_JOURNAL_STATE_BY_OUTCOME[outcome])
            self.journal.close()
        except (JournalDurabilityError, OSError) as exc:
            logger.warning("Could not close action journal", error=str(exc))

    # ---------------------------------------------------------------- #
    # Placement                                                          #
    # ---------------------------------------------------------------- #

    def place(
        self,
        source: Path,
        destination: Path,
        *,
        kind: MutationActionKind,
        move: bool,
        root_id: str,
        relative_path: str,
        known_sha256: str | None = None,
        sidecar: SidecarEffect = "none",
        rule_version: str | None = None,
        unit_id: str | None = None,
        companion_role: CompanionRole | None = None,
        unit_primary_path: str | None = None,
        provenance: OutcomeProvenance | None = None,
    ) -> TransferResult:
        """Authorize, journal, and verify one placement, then record its outcome."""
        self._assert_not_protected(source, destination)
        planned = (
            self.plan_guard.authorize(
                source,
                destination,
                kind=kind,
                move=move,
                unit_id=unit_id,
                companion_role=companion_role,
            )
            if self.plan_guard is not None
            else None
        )
        action = build_placement_action(
            source,
            destination,
            kind=kind,
            move=move,
            preservation=self.preservation,
            root_id=root_id,
            relative_path=relative_path,
            known_sha256=known_sha256,
            sidecar=sidecar,
            rule_version=rule_version,
            unit_id=unit_id,
            companion_role=companion_role,
            unit_primary_path=unit_primary_path,
            provenance=planned.provenance if planned is not None else provenance,
        )
        if self.journal is not None:
            self.journal.authorize(action)
        self.emit(
            "action.authorized",
            action_id=action.action_id,
            phase="executing",
            kind=kind,
            source_path=str(source),
            destination_path=str(destination),
        )
        result = execute_transfer(action, journal=self.journal)
        outcome = self.record(result)
        self.emit(
            "action.outcome",
            action_id=action.action_id,
            phase="executing",
            outcome=outcome.code,
            source_safety=result.source_safety,
            commit_method=result.commit_method,
            destination_path=str(result.destination_path),
        )
        if result.reduced_guarantee is not None:
            self.emit(
                "transfer.degraded",
                action_id=action.action_id,
                phase="executing",
                reason=result.reduced_guarantee,
            )
        return result

    def verify_reviewed_destination(
        self,
        source: Path,
        destination: Path,
        *,
        unit_id: str | None = None,
        companion_role: CompanionRole | None = None,
    ) -> None:
        if self.plan_guard is not None:
            self.plan_guard.verify_final_destination(
                source,
                destination,
                unit_id=unit_id,
                companion_role=companion_role,
            )

    def _assert_not_protected(self, source: Path, destination: Path) -> None:
        """Refuse to touch anything inside a comparison-only reference root.

        Reference roots exist so a user can deduplicate *against* a library they
        do not want reorganized. Enforcing that here, at the one place media
        moves, means no pipeline step can violate it by forgetting to check.
        """
        for role, candidate in (("source", source), ("destination", destination)):
            protected = _containing_root(candidate, self.protected_roots)
            if protected is None:
                continue
            self.emit(
                "integrity.violation",
                phase="executing",
                reason="reference_root_is_immutable",
                path=str(candidate),
            )
            raise MutationPolicyError(
                "Reference folders are compared against, never changed.",
                reason="reference_root_is_immutable",
                role=role,
                path=str(candidate),
                reference_root=str(protected),
                source_safety="source_retained",
            )

    def record(self, result: TransferResult, *, code: str | None = None) -> ActionOutcome:
        outcome = ActionOutcome(
            action_id=result.action_id,
            code=_outcome_code(result) if code is None else code,  # type: ignore[arg-type]
            source_safety=result.source_safety,
            source_path=str(result.source_path),
            result_path=str(result.destination_path),
            integrity=result.integrity,
            commit_method=result.commit_method,
            filesystem_metadata_requested=result.requested_metadata,
            filesystem_metadata_observed=result.observed_metadata,
            warnings=result.warnings,
            diagnostic_code=result.reduced_guarantee,
        )
        self.outcomes.append(outcome)
        size = result.observed_metadata.size_bytes
        if result.integrity_source == "measured":
            self.bytes_read += size
            self.bytes_written += size
        return outcome

    def record_failure(
        self,
        *,
        action_id: str,
        source_path: Path,
        code: str,
        diagnostic_code: str | None,
        source_safety: str = "source_retained",
    ) -> None:
        self.outcomes.append(
            ActionOutcome(
                action_id=action_id,
                code=code,  # type: ignore[arg-type]
                source_safety=source_safety,  # type: ignore[arg-type]
                source_path=str(source_path),
                diagnostic_code=diagnostic_code,
            )
        )

    # ---------------------------------------------------------------- #
    # Reporting                                                          #
    # ---------------------------------------------------------------- #

    def build_report(self, outcome: OperationOutcomeCode) -> IntegrityReport:
        return IntegrityReport(
            report_id=f"rep_{uuid.uuid4().hex[:16]}",
            operation_id=self.operation_id,
            manifest_id=self.operation_id,
            profile_id=self.preservation.profile_id,
            started_at=self.started_at,  # type: ignore[arg-type]
            finished_at=utc_now(),
            outcome=outcome,
            counts=self.counts(),
            bytes_read=self.bytes_read,
            bytes_written=self.bytes_written,
            actions=tuple(self.outcomes),
            warnings=tuple(sorted({w for item in self.outcomes for w in item.warnings})),
            recovery_state="required" if self.unresolved else "none",
        )

    def counts(self) -> OutcomeCounts:
        tally: dict[str, int] = {}
        for item in self.outcomes:
            tally[item.code] = tally.get(item.code, 0) + 1
        return OutcomeCounts(
            verified_success=tally.get("verified_success", 0),
            warnings=tally.get("success_with_metadata_limitation", 0),
            skipped=tally.get("skipped", 0),
            quarantined=tally.get("quarantined", 0),
            cancelled=tally.get("cancelled", 0),
            blocked=tally.get("blocked", 0),
            failed=tally.get("failed", 0) + tally.get("integrity_failed", 0),
            unresolved=tally.get("reconciliation_required", 0) + tally.get("partial", 0),
        )

    @property
    def unresolved(self) -> bool:
        return any(
            item.code in {"reconciliation_required", "partial", "integrity_failed"}
            for item in self.outcomes
        )

    def store_report(self, outcome: OperationOutcomeCode) -> Path | None:
        """Persist the aggregate integrity report next to the durable records."""
        report = self.build_report(outcome)
        directory = self.state_root / REPORT_DIRECTORY_NAME
        try:
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{_safe(self.operation_id)}{REPORT_SUFFIX}"
            path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
        except OSError as exc:
            logger.warning(
                "Could not store integrity report",
                operation_id=self.operation_id,
                error=str(exc),
            )
            return None
        return path


_JOURNAL_STATE_BY_OUTCOME: dict[
    OperationOutcomeCode,
    Literal["completed", "cancelled", "failed", "reconciliation_required"],
] = {
    "completed": "completed",
    "completed_with_warnings": "completed",
    "partial": "reconciliation_required",
    "cancelled": "cancelled",
    "failed": "failed",
}


def _containing_root(candidate: Path, roots: Sequence[Path]) -> Path | None:
    resolved = candidate.resolve(strict=False)
    for root in roots:
        try:
            resolved.relative_to(root.resolve(strict=False))
        except ValueError:
            continue
        return root
    return None


def _outcome_code(result: TransferResult) -> str:
    return "success_with_metadata_limitation" if result.warnings else "verified_success"


def _safe(identifier: str) -> str:
    return (
        "".join(
            character if character.isalnum() or character in {"-", "_"} else "-"
            for character in identifier
        )[:128]
        or "operation"
    )
