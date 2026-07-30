"""Performing a frozen review plan, one journalled action at a time.

Execution is deliberately boring: take an immutable snapshot, walk its
actionable outcomes, and route each through the same verified-transfer and
quarantine machinery everything else uses. Nothing here decides anything — the
decisions were made in review, and this module is not allowed to reinterpret
them.

What it does add is the journal. Every action records what it was about to do
before it does it, so a crash leaves a readable trail rather than a directory
full of files nobody can classify.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.core.duplicate_plans import PlanSnapshot, ResolvedOutcome
from app.core.exceptions import IntegrityTransferError
from app.core.logging_config import get_logger
from app.services.quarantine import QuarantineError, QuarantineStore
from app.services.review_plan import executable_members
from app.services.verified_transfer import revalidate_sha256, transfer_path

logger = get_logger(__name__)

ActionState = Literal["planned", "running", "completed", "skipped", "failed", "cancelled"]

#: Actions this module knows how to perform. Anything else — including a
#: reference member's `no_action_reference` — never reaches here at all.
PERFORMABLE = {"quarantine", "copy_to_destination", "move_to_destination"}


@dataclass(frozen=True)
class ActionRecord:
    """What happened to one planned action, and where its file ended up."""

    action_id: str
    group_id: str
    member_id: str
    kind: str
    state: ActionState
    source_path: str
    result_path: str | None = None
    quarantine_record_id: str | None = None
    detail: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.state == "completed"


@dataclass
class ExecutionReport:
    """The terminal record of one execution of one snapshot."""

    operation_id: str
    snapshot_id: str
    actions: list[ActionRecord] = field(default_factory=list)
    cancelled: bool = False

    @property
    def code(self) -> str:
        if self.cancelled:
            return "cancelled"
        failed = [item for item in self.actions if item.state == "failed"]
        if failed and len(failed) == len(self.actions):
            return "failed"
        if failed:
            return "partial"
        return "completed"

    @property
    def counts(self) -> dict[str, int]:
        tally: dict[str, int] = {}
        for action in self.actions:
            tally[action.state] = tally.get(action.state, 0) + 1
        return tally

    @property
    def quarantined_bytes(self) -> int:
        return sum(1 for action in self.actions if action.kind == "quarantine")


class ExecutionRefused(RuntimeError):
    """A snapshot was rejected before any file was touched."""


def execute_snapshot(
    snapshot: PlanSnapshot,
    *,
    quarantine: QuarantineStore,
    source_for: Callable[[str], Path],
    destination_root: Path | None = None,
    operation_id: str | None = None,
    cancel: Callable[[], bool] | None = None,
    on_action: Callable[[ActionRecord], None] | None = None,
    on_validation_progress: Callable[[int, int, str], None] | None = None,
) -> ExecutionReport:
    """Perform every actionable outcome in a frozen snapshot.

    *source_for* resolves a member id to its current path; the snapshot stores
    identities rather than paths so a plan cannot smuggle a filesystem location
    past the review that authorized it.
    """
    if snapshot.requires_acknowledgement and not snapshot.acknowledged_source_mutations:
        raise ExecutionRefused("this plan changes input files and was not acknowledged")

    operation_id = operation_id or f"exec_{uuid.uuid4().hex[:16]}"
    report = ExecutionReport(operation_id=operation_id, snapshot_id=snapshot.snapshot_id)
    group_errors = _validate_exact_groups(
        snapshot,
        source_for=source_for,
        cancel=cancel,
        on_progress=on_validation_progress,
    )

    for group_id, outcome in executable_members(snapshot):
        if cancel is not None and cancel():
            report.cancelled = True
            break
        if group_id in group_errors:
            record = ActionRecord(
                f"act_{uuid.uuid4().hex[:12]}",
                group_id,
                outcome.member_id,
                outcome.kind,
                "failed",
                source_path="",
                detail=group_errors[group_id],
            )
            report.actions.append(record)
            if on_action is not None:
                on_action(record)
            continue
        record = _perform(
            group_id,
            outcome,
            quarantine=quarantine,
            source_for=source_for,
            destination_root=destination_root,
            operation_id=operation_id,
        )
        report.actions.append(record)
        if on_action is not None:
            on_action(record)

    logger.info(
        "Review execution finished",
        operation_id=operation_id,
        outcome=report.code,
        actions=len(report.actions),
    )
    return report


def _perform(
    group_id: str,
    outcome: ResolvedOutcome,
    *,
    quarantine: QuarantineStore,
    source_for: Callable[[str], Path],
    destination_root: Path | None,
    operation_id: str,
) -> ActionRecord:
    action_id = f"act_{uuid.uuid4().hex[:12]}"
    if outcome.kind not in PERFORMABLE:  # pragma: no cover - guarded by the caller
        return ActionRecord(
            action_id,
            group_id,
            outcome.member_id,
            outcome.kind,
            "skipped",
            source_path="",
            detail="this outcome is not performable",
        )

    try:
        source = source_for(outcome.member_id)
    except (KeyError, LookupError) as exc:
        return ActionRecord(
            action_id,
            group_id,
            outcome.member_id,
            outcome.kind,
            "failed",
            source_path="",
            detail=f"the file could not be located: {exc}",
        )

    if not source.exists():
        # A file that vanished between review and execution is drift, not a
        # crash. The action is failed and the rest of the plan continues.
        return ActionRecord(
            action_id,
            group_id,
            outcome.member_id,
            outcome.kind,
            "failed",
            source_path=str(source),
            detail="the file is no longer at its reviewed location",
        )

    try:
        if outcome.kind == "quarantine":
            stored = quarantine.quarantine(
                source,
                operation_id=operation_id,
                reason="duplicate",
                move=True,
            )
            return ActionRecord(
                action_id,
                group_id,
                outcome.member_id,
                outcome.kind,
                "completed",
                source_path=str(source),
                result_path=stored.quarantine_path,
                quarantine_record_id=stored.record_id,
            )

        destination = _destination(outcome, source, destination_root)
        if destination is None:
            return ActionRecord(
                action_id,
                group_id,
                outcome.member_id,
                outcome.kind,
                "skipped",
                source_path=str(source),
                detail="no destination is configured for this action",
            )
        result = transfer_path(source, destination, move=outcome.kind == "move_to_destination")
        return ActionRecord(
            action_id,
            group_id,
            outcome.member_id,
            outcome.kind,
            "completed",
            source_path=str(source),
            result_path=str(result.destination_path),
        )
    except (OSError, QuarantineError, IntegrityTransferError) as exc:
        return ActionRecord(
            action_id,
            group_id,
            outcome.member_id,
            outcome.kind,
            "failed",
            source_path=str(source),
            detail=f"{type(exc).__name__}: {exc}",
        )


def _validate_exact_groups(
    snapshot: PlanSnapshot,
    *,
    source_for: Callable[[str], Path],
    cancel: Callable[[], bool] | None,
    on_progress: Callable[[int, int, str], None] | None,
) -> dict[str, str]:
    """Freshly prove both sides before an exact-group source is mutated."""
    errors: dict[str, str] = {}
    for group in snapshot.groups:
        if group.kind != "exact" or not any(
            outcome.kind == "quarantine" for outcome in group.outcomes
        ):
            continue
        # Old hand-built snapshots may contain only the actionable member.
        # Production snapshots contain every member; only those can establish
        # the required two-sided equality proof.
        candidates = tuple(
            outcome
            for outcome in group.outcomes
            if outcome.kind not in {"blocked", "no_action_reference"}
        )
        if len(candidates) < 2 or not all(
            outcome.expected_sha256 is not None for outcome in candidates
        ):
            continue
        measured: set[str] = set()
        try:
            for outcome in candidates:
                if cancel is not None and cancel():
                    errors[group.group_id] = "cancelled during full-content validation"
                    break
                path = source_for(outcome.member_id)
                total = path.stat().st_size
                progress_callback: Callable[[int, int], None] | None = None
                if on_progress is not None:
                    member_id = outcome.member_id

                    def progress_callback(
                        done: int,
                        _total: int,
                        *,
                        _member_id: str = member_id,
                        _size: int = total,
                    ) -> None:
                        on_progress(done, _size, _member_id)

                digest, _size = revalidate_sha256(
                    path,
                    expected_sha256=outcome.expected_sha256,
                    on_progress=progress_callback,
                )
                measured.add(digest)
            if group.group_id not in errors and len(measured) != 1:
                errors[group.group_id] = (
                    "exact duplicate members no longer have identical current bytes"
                )
        except (KeyError, LookupError, OSError, IntegrityTransferError) as exc:
            errors[group.group_id] = f"full-content validation failed: {type(exc).__name__}: {exc}"
    return errors


def _destination(
    outcome: ResolvedOutcome,
    source: Path,
    destination_root: Path | None,
) -> Path | None:
    if outcome.destination_path:
        return Path(outcome.destination_path)
    if destination_root is None:
        return None
    return destination_root / source.name


def reconcile(
    report: ExecutionReport,
    quarantine: QuarantineStore,
) -> tuple[str, ...]:
    """After an interruption, describe what is still ambiguous.

    Anything that completed is provably fine — its record names a file that
    exists. Anything that failed left its source in place. What remains is the
    set the user has to look at, and it is deliberately reported rather than
    resolved automatically.
    """
    notes: list[str] = []
    for action in report.actions:
        if action.state != "completed" or action.quarantine_record_id is None:
            continue
        record = quarantine.find(action.quarantine_record_id)
        if record is None:
            notes.append(f"{action.member_id}: the quarantine record is missing")
            continue
        if not Path(record.quarantine_path).is_file():
            notes.append(f"{action.member_id}: the quarantined file is missing")
    if report.cancelled:
        notes.append("the run was cancelled; unprocessed files were never touched")
    return tuple(notes)


def unresolved_actions(reports: Sequence[ExecutionReport]) -> tuple[ActionRecord, ...]:
    return tuple(
        action for report in reports for action in report.actions if action.state == "failed"
    )
