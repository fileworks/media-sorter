"""Turn transfer authorization/integrity refusals into actionable run evidence."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from app.core.exceptions import IntegrityTransferError, PlanAuthorizationError
from app.core.integrity import SourceSafetyState
from app.core.logging_config import get_logger

if TYPE_CHECKING:
    from app.services.operation_execution import OperationExecution

logger = get_logger(__name__)


def record_plan_authorization_failure(
    exc: PlanAuthorizationError,
    *,
    file_path: Path,
    record: dict[str, Any],
    execution: OperationExecution | None,
    action_id: str,
) -> None:
    """Record a reviewed-plan mismatch as blocked, not unreadable media."""
    reason = str(exc.details.get("reason") or "unplanned_action")
    logger.error("Placement is not in the reviewed plan", path=str(file_path), reason=reason)
    if execution is not None:
        execution.emit("integrity.violation", phase="sorting", reason=reason, path=str(file_path))
        execution.record_failure(
            action_id=action_id,
            source_path=file_path,
            code="blocked",
            diagnostic_code=reason,
        )
    record.update(status="blocked", error_message=str(exc))


def record_integrity_transfer_failure(
    exc: IntegrityTransferError,
    *,
    file_path: Path,
    record: dict[str, Any],
    execution: OperationExecution | None,
    fallback_action_id: str,
) -> None:
    """Preserve source-safety evidence when final transfer checks refuse."""
    reason = str(exc.details.get("reason") or "integrity_transfer_failed")
    raw_safety = str(exc.details.get("source_safety") or "source_retained")
    source_safety = cast(
        SourceSafetyState,
        raw_safety
        if raw_safety
        in {
            "source_retained",
            "source_verified",
            "redundant_verified_copies",
            "destination_verified",
            "ambiguous",
        }
        else "source_retained",
    )
    logger.error(
        "Transfer integrity requires reconciliation",
        path=str(file_path),
        reason=reason,
        source_safety=source_safety,
    )
    if execution is not None:
        execution.emit("integrity.violation", phase="sorting", reason=reason, path=str(file_path))
        execution.record_failure(
            action_id=str(exc.details.get("action_id") or fallback_action_id),
            source_path=file_path,
            code="reconciliation_required",
            diagnostic_code=reason,
            source_safety=source_safety,
        )
    record.update(
        status="blocked",
        error_message=f"{exc} The source was retained; review the unresolved integrity action.",
        source_safety=source_safety,
        integrity_diagnostic=reason,
    )
