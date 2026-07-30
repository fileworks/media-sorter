"""Staged optimization: encode, prove, commit — and only ever in that order.

Every optimized output is produced beside its original, decoded again, measured
against its contract, and compared for metadata policy before anything visible
changes. A result that fails, or that merely *cannot prove* it passed, is
discarded and the original is left exactly where it was.

On acceptance the original is not deleted. It moves into managed quarantine with
a restore relation to the output, because the one thing a user cannot recover
from is a re-encode they disagree with after the fact.
"""

from __future__ import annotations

import shutil
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.core.integrity import (
    ActionOutcome,
    OptimizationProfile,
    QualityEvidence,
    utc_now,
)
from app.core.logging_config import get_logger
from app.core.optimization_contracts import (
    FormatContract,
    OptimizationUnavailableError,
    discover_tool,
)
from app.core.optimization_contracts import (
    contract as load_contract,
)
from app.services.optimization_encoders import (
    Encoder,
    encoder_for,
    evaluate_metrics,
    probe,
)
from app.services.quarantine import QuarantineRecord, QuarantineStore
from app.services.verified_transfer import stream_sha256, transfer_path

logger = get_logger(__name__)

STAGING_DIRECTORY_NAME = "optimize-stage"

OptimizationOutcomeCode = Literal[
    "optimized",
    "rejected",
    "indeterminate",
    "skipped",
    "blocked",
    "failed",
]


class OptimizationBlocked(OptimizationUnavailableError):
    """Preflight refused to run an optimizer, before any original was touched."""


@dataclass(frozen=True)
class OptimizationOutcome:
    """What happened to one original, and what state it is now in."""

    action_id: str
    source_path: Path
    code: OptimizationOutcomeCode
    contract_id: str
    committed_path: Path | None = None
    quarantine_record: QuarantineRecord | None = None
    quality: QualityEvidence | None = None
    source_bytes: int = 0
    result_bytes: int | None = None
    warnings: tuple[str, ...] = ()
    diagnostic_code: str | None = None
    detail: str | None = None

    @property
    def source_safe(self) -> bool:
        """Whether the original's bytes still exist somewhere reachable."""
        return self.code != "failed" or self.source_path.exists()

    @property
    def saved_bytes(self) -> int:
        if self.result_bytes is None or self.code != "optimized":
            return 0
        return max(self.source_bytes - self.result_bytes, 0)


def preflight(
    profile: OptimizationProfile,
    items: Sequence[Path],
) -> tuple[FormatContract, Encoder]:
    """Refuse the whole batch before the first original is read.

    The plan is checked against the contract, the acknowledgement, and the tool
    that must exist on *this* machine. Blocking here is the difference between
    "nothing happened" and "half the library was re-encoded by a fallback".
    """
    if profile.mode == "disabled" or profile.validation_contract is None:
        raise OptimizationBlocked("optimization is disabled for this profile")
    contract = load_contract(profile.validation_contract)
    if not contract.enabled:
        raise OptimizationBlocked(
            f"{contract.contract_id} is {contract.status}; it has not passed its fixtures"
        )
    if profile.acknowledged_at is None:
        raise OptimizationBlocked("optimization requires an explicit acknowledgement")
    capability = discover_tool(contract.tool)
    if not capability.available:
        raise OptimizationBlocked(f"{contract.tool} is unavailable on this machine")
    if profile.tool_version and capability.version and profile.tool_version != capability.version:
        # A different encoder build is a different result. The projections the
        # user approved were made with the recorded one, so they no longer hold.
        raise OptimizationBlocked(
            "the installed encoder differs from the one this plan was projected with"
        )
    unsupported = [item for item in items if item.suffix.lower() not in contract.source_formats]
    if unsupported:
        raise OptimizationBlocked(
            f"{len(unsupported)} item(s) are not covered by {contract.contract_id}"
        )
    return contract, encoder_for(contract)


def optimize_file(
    source: Path,
    *,
    profile: OptimizationProfile,
    contract: FormatContract,
    encoder: Encoder,
    state_root: Path,
    quarantine: QuarantineStore,
    operation_id: str,
    destination: Path | None = None,
) -> OptimizationOutcome:
    """Run one file through stage → validate → commit → quarantine.

    Returns rather than raises for anything that is a media outcome; only a
    programming error escapes. The caller records the outcome and moves on, so
    one unusual file never ends a batch.
    """
    action_id = f"opt_{uuid.uuid4().hex[:16]}"
    source_bytes = source.stat().st_size
    staging = state_root / STAGING_DIRECTORY_NAME / action_id
    target = destination or source.with_suffix(f".{contract.output_container}")

    if profile.temporary_space_limit_bytes is not None:
        needed = source_bytes * 2
        if needed > profile.temporary_space_limit_bytes:
            return OptimizationOutcome(
                action_id,
                source,
                "skipped",
                contract.contract_id,
                source_bytes=source_bytes,
                diagnostic_code="temporary_space_limit",
                detail="staging this file would exceed the configured temporary-space limit",
            )

    try:
        staging.mkdir(parents=True, exist_ok=True)
        candidate = staging / f"{source.stem}.{contract.output_container}"
        attempt = encoder.encode(source, candidate)
        if not attempt.produced_candidate or attempt.candidate_path is None:
            return OptimizationOutcome(
                action_id,
                source,
                "failed",
                contract.contract_id,
                source_bytes=source_bytes,
                diagnostic_code="encoder_failed",
                detail=attempt.error,
            )

        quality = _validate(
            contract,
            source=source,
            candidate=attempt.candidate_path,
            measurements=dict(attempt.measurements),
            encoder_warnings=attempt.warnings,
        )
        if quality.passed is not True:
            code: OptimizationOutcomeCode = (
                "rejected" if quality.passed is False else "indeterminate"
            )
            return OptimizationOutcome(
                action_id,
                source,
                code,
                contract.contract_id,
                quality=quality,
                source_bytes=source_bytes,
                result_bytes=attempt.candidate_bytes,
                warnings=quality.warnings,
                diagnostic_code="quality_contract_unmet",
                detail="the original was left untouched",
            )

        # Everything below only runs on a fully accepted result. The original
        # goes to quarantine *first*: if the commit then fails, the worst case
        # is a file in quarantine with a record, never a file that is gone.
        record = quarantine.quarantine(
            source,
            operation_id=operation_id,
            reason="optimization_original",
            keeper_path=target,
            move=True,
            notes=(f"replaced by {contract.contract_id}",),
        )
        result = transfer_path(attempt.candidate_path, target, move=True)
        return OptimizationOutcome(
            action_id,
            source,
            "optimized",
            contract.contract_id,
            committed_path=result.destination_path,
            quarantine_record=record,
            quality=quality,
            source_bytes=source_bytes,
            result_bytes=result.observed_metadata.size_bytes,
            warnings=quality.warnings + result.warnings,
        )
    except OSError as exc:
        return OptimizationOutcome(
            action_id,
            source,
            "failed",
            contract.contract_id,
            source_bytes=source_bytes,
            diagnostic_code="filesystem_error",
            detail=f"{type(exc).__name__}: {exc}",
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _validate(
    contract: FormatContract,
    *,
    source: Path,
    candidate: Path,
    measurements: dict[str, object],
    encoder_warnings: tuple[str, ...],
) -> QualityEvidence:
    """Prove the candidate independently of the encoder that produced it.

    The encoder's own measurements are kept, but decode success, integrity of
    the written bytes, and metadata policy are re-established here, so a broken
    encoder cannot certify itself.
    """
    warnings = list(encoder_warnings)
    decoded = _decodes(contract, candidate)
    try:
        digest, size = stream_sha256(candidate)
    except OSError as exc:
        return evaluate_metrics(
            contract,
            measurements,  # type: ignore[arg-type]
            decoded_successfully=False,
            sampling_scope="whole output",
            warnings=(*warnings, f"the staged output could not be read: {exc}"),
        )
    measurements["output_sha256"] = digest
    measurements["output_size_bytes"] = size
    if size == 0:
        decoded = False
        warnings.append("the encoder produced an empty file")

    metadata_note = _metadata_note(contract, source, candidate)
    if metadata_note:
        warnings.append(metadata_note)

    return evaluate_metrics(
        contract,
        measurements,  # type: ignore[arg-type]
        decoded_successfully=decoded,
        sampling_scope="whole output",
        warnings=tuple(warnings),
    )


def _decodes(contract: FormatContract, candidate: Path) -> bool:
    """Whether the written file can actually be read back as media."""
    if contract.media_kind == "image":
        try:
            from PIL import Image

            with Image.open(candidate) as image:
                image.load()
        except Exception:  # noqa: BLE001 - any decode failure is a rejection
            return False
        return True
    described = probe(candidate)
    return described is not None and described.stream_count > 0


def _metadata_note(contract: FormatContract, source: Path, candidate: Path) -> str | None:
    """Report what the declared metadata policy could not fully deliver."""
    if contract.media_kind != "image":
        return None
    try:
        from PIL import Image

        with Image.open(source) as before, Image.open(candidate) as after:
            lost = sorted(set(_text_keys(before)) - set(_text_keys(after)))
    except Exception:  # noqa: BLE001 - metadata inspection is advisory
        return "embedded metadata could not be compared"
    if lost:
        return f"embedded metadata not carried over: {', '.join(lost)}"
    return None


def _text_keys(image: object) -> tuple[str, ...]:
    info = getattr(image, "info", {}) or {}
    return tuple(str(key) for key in info if key not in {"transparency", "gamma"})


def outcome_to_action(outcome: OptimizationOutcome) -> ActionOutcome:
    """Project an optimization outcome into the shared report vocabulary."""
    code = {
        "optimized": "verified_success",
        "rejected": "skipped",
        "indeterminate": "skipped",
        "skipped": "skipped",
        "blocked": "blocked",
        "failed": "failed",
    }[outcome.code]
    return ActionOutcome(
        action_id=outcome.action_id,
        code=code,  # type: ignore[arg-type]
        source_safety="redundant_verified_copies"
        if outcome.code == "optimized"
        else "source_retained",
        source_path=str(outcome.source_path),
        result_path=None if outcome.committed_path is None else str(outcome.committed_path),
        quality=outcome.quality,
        commit_method="staged_atomic_promote" if outcome.code == "optimized" else "none",
        warnings=outcome.warnings,
        diagnostic_code=outcome.diagnostic_code,
    )


def optimize_batch(
    items: Sequence[Path],
    *,
    profile: OptimizationProfile,
    state_root: Path,
    quarantine: QuarantineStore,
    operation_id: str | None = None,
) -> tuple[OptimizationOutcome, ...]:
    """Preflight once, then optimize each item independently."""
    operation_id = operation_id or f"opt_{utc_now():%Y%m%d%H%M%S}"
    contract, encoder = preflight(profile, items)
    return tuple(
        optimize_file(
            item,
            profile=profile,
            contract=contract,
            encoder=encoder,
            state_root=state_root,
            quarantine=quarantine,
            operation_id=operation_id,
        )
        for item in items
    )
