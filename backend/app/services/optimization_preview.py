"""What optimization would cost and save, measured on a bounded sample.

A projection is never allowed to look more certain than the evidence behind it.
Items whose own bytes were encoded get a ``measured`` projection; items covered
by a representative of their kind get ``sampled`` with a range; everything else
is ``estimated`` or, when nothing supports a number at all, ``unknown`` with the
reason attached instead of a figure.

Nothing here mutates a single original. The sample encodes land in a temporary
directory that is removed with the preview, and the resulting plan is an input
to :mod:`app.services.optimization_execution`, which validates every real output
again on its own.
"""

from __future__ import annotations

import statistics
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.core.integrity import QualityEvidence
from app.core.logging_config import get_logger
from app.core.optimization_contracts import FormatContract
from app.core.optimization_contracts import contract as load_contract
from app.services.optimization_encoders import (
    EncodeAttempt,
    Encoder,
    encoder_for,
    evaluate_metrics,
)

logger = get_logger(__name__)

Confidence = Literal["measured", "sampled", "estimated", "unknown"]
Recommendation = Literal["optimize", "skip", "blocked"]

#: Sampling budget. Three encodes across the size distribution answer "roughly
#: how much does this library compress" without turning a preview into the run.
DEFAULT_MAX_SAMPLES = 3
DEFAULT_MAX_SAMPLE_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_ITEM_BYTES = 128 * 1024 * 1024

#: How wide a sampled projection is allowed to claim to be. Real libraries vary
#: far more than one encode suggests, so a sampled ratio is presented as a band.
SAMPLED_SPREAD = 0.35


@dataclass(frozen=True)
class PreviewItem:
    """One candidate for optimization, as the planner knows it."""

    path: Path
    size_bytes: int

    @classmethod
    def from_path(cls, path: Path) -> PreviewItem:
        return cls(path, path.stat().st_size)


@dataclass(frozen=True)
class SampleEncode:
    """A representative encode the user may open and compare."""

    source_path: Path
    candidate_path: Path | None
    source_bytes: int
    candidate_bytes: int
    size_reduction_ratio: float
    quality: QualityEvidence
    #: Exactly what was encoded, e.g. "whole file" or "first 20s".
    sampling_scope: str
    warnings: tuple[str, ...] = ()

    @property
    def accepted(self) -> bool:
        return self.quality.passed is True

    @property
    def comparable(self) -> bool:
        """Whether the candidate still exists for side-by-side comparison."""
        return self.candidate_path is not None and self.candidate_path.is_file()


@dataclass(frozen=True)
class ItemProjection:
    """Per-item projection with its confidence and its reason for existing."""

    path: Path
    current_bytes: int
    projected_low_bytes: int | None
    projected_high_bytes: int | None
    estimated_saving_bytes: int | None
    confidence: Confidence
    output_container: str
    output_codec: str
    quality_setting: str
    validation_method: str
    compatibility_warnings: tuple[str, ...]
    temporary_space_bytes: int
    quarantine_space_bytes: int
    recommendation: Recommendation
    reason: str
    sample_source_path: Path | None = None

    @property
    def estimate_only(self) -> bool:
        return self.confidence in {"estimated", "unknown"}


@dataclass(frozen=True)
class OptimizationProjection:
    """The aggregate a preview screen is rendered from."""

    contract_id: str
    mode: str
    output_container: str
    output_codec: str
    item_count: int
    current_bytes: int
    projected_low_bytes: int | None
    projected_high_bytes: int | None
    estimated_saving_bytes: int | None
    confidence: Confidence
    recommended_count: int
    skipped_count: int
    blocked_count: int
    temporary_space_bytes: int
    quarantine_space_bytes: int
    samples: tuple[SampleEncode, ...] = ()
    items: tuple[ItemProjection, ...] = ()
    warnings: tuple[str, ...] = ()
    compatibility_warnings: tuple[str, ...] = ()
    failures: tuple[str, ...] = ()

    @property
    def estimate_only(self) -> bool:
        """True when no candidate media exists, so the UI must not fake one."""
        return not any(sample.comparable for sample in self.samples)


@dataclass
class SamplePlan:
    """The bounded set of items a preview is allowed to actually encode."""

    items: tuple[PreviewItem, ...]
    skipped_reason: str | None = None
    budget_bytes: int = DEFAULT_MAX_SAMPLE_BYTES
    considered: int = 0
    excluded: tuple[str, ...] = field(default_factory=tuple)


def select_samples(
    items: Sequence[PreviewItem],
    *,
    max_samples: int = DEFAULT_MAX_SAMPLES,
    max_total_bytes: int = DEFAULT_MAX_SAMPLE_BYTES,
    max_item_bytes: int = DEFAULT_MAX_ITEM_BYTES,
) -> SamplePlan:
    """Pick a small, deterministic, size-stratified sample.

    Smallest, median, and largest eligible item — in that order — because
    compression behaves differently at each end and one arbitrary file would
    make the projection depend on directory order.
    """
    eligible = sorted(
        (item for item in items if 0 < item.size_bytes <= max_item_bytes),
        key=lambda item: (item.size_bytes, str(item.path)),
    )
    excluded = tuple(
        f"{item.path.name} is larger than the {max_item_bytes // (1024 * 1024)} MiB sample limit"
        for item in items
        if item.size_bytes > max_item_bytes
    )
    if not eligible:
        return SamplePlan(
            (),
            skipped_reason="no item was small enough to encode within the sample budget",
            budget_bytes=max_total_bytes,
            considered=len(items),
            excluded=excluded,
        )

    indexes = _stratified_indexes(len(eligible), max_samples)
    chosen: list[PreviewItem] = []
    spent = 0
    for index in indexes:
        candidate = eligible[index]
        if spent + candidate.size_bytes > max_total_bytes and chosen:
            break
        chosen.append(candidate)
        spent += candidate.size_bytes
    return SamplePlan(
        tuple(chosen),
        budget_bytes=max_total_bytes,
        considered=len(items),
        excluded=excluded,
    )


def _stratified_indexes(count: int, wanted: int) -> tuple[int, ...]:
    if count <= wanted:
        return tuple(range(count))
    if wanted <= 1:
        return (count // 2,)
    step = (count - 1) / (wanted - 1)
    return tuple(sorted({round(position * step) for position in range(wanted)}))


def project_optimization(
    items: Sequence[PreviewItem],
    contract_id: str,
    *,
    encoder: Encoder | None = None,
    workspace: Path | None = None,
    max_samples: int = DEFAULT_MAX_SAMPLES,
    max_total_bytes: int = DEFAULT_MAX_SAMPLE_BYTES,
    sample_seconds: float | None = 20.0,
) -> OptimizationProjection:
    """Encode a bounded sample and project the whole set from what it proved.

    *workspace* holds the generated candidates; the caller owns its lifetime so
    the comparison modal can still read them after this returns. Without one, a
    temporary directory is used and removed immediately, which downgrades the
    result to numbers without openable candidates.
    """
    contract = load_contract(contract_id)
    supported, unsupported = _partition_supported(items, contract)
    if not supported:
        return _empty_projection(contract, items, reason="no item matches this contract's formats")

    encoder = encoder or _encoder_for(contract, sample_seconds=sample_seconds)
    plan = select_samples(supported, max_samples=max_samples, max_total_bytes=max_total_bytes)

    if workspace is None:
        # The measurements survive; the candidate media does not. The projection
        # keeps its numbers and loses only the ability to be compared visually.
        with tempfile.TemporaryDirectory(prefix="mediasort-optimize-preview-") as tmp:
            encoded, failures = _encode_samples(plan, encoder, Path(tmp), contract, sample_seconds)
        samples = tuple(
            SampleEncode(**{**vars(sample), "candidate_path": None}) for sample in encoded
        )
    else:
        workspace.mkdir(parents=True, exist_ok=True)
        samples, failures = _encode_samples(plan, encoder, workspace, contract, sample_seconds)

    return _build_projection(
        contract=contract,
        supported=supported,
        unsupported=unsupported,
        samples=samples,
        failures=failures,
        plan=plan,
    )


def _encoder_for(contract: FormatContract, *, sample_seconds: float | None) -> Encoder:
    if contract.tool == "ffmpeg":
        return encoder_for(contract, sample_seconds=sample_seconds)
    return encoder_for(contract)


def _partition_supported(
    items: Iterable[PreviewItem], contract: FormatContract
) -> tuple[tuple[PreviewItem, ...], tuple[PreviewItem, ...]]:
    supported: list[PreviewItem] = []
    unsupported: list[PreviewItem] = []
    for item in items:
        target = supported if item.path.suffix.lower() in contract.source_formats else unsupported
        target.append(item)
    return tuple(supported), tuple(unsupported)


def _encode_samples(
    plan: SamplePlan,
    encoder: Encoder,
    workspace: Path,
    contract: FormatContract,
    sample_seconds: float | None,
) -> tuple[tuple[SampleEncode, ...], tuple[str, ...]]:
    samples: list[SampleEncode] = []
    failures: list[str] = []
    for index, item in enumerate(plan.items):
        destination = workspace / f"sample{index}-{item.path.stem}.{contract.output_container}"
        attempt = encoder.encode(item.path, destination)
        if not attempt.produced_candidate or attempt.candidate_bytes is None:
            failures.append(f"{item.path.name}: {attempt.error or 'no candidate produced'}")
            continue
        samples.append(_sample_from(attempt, contract, sample_seconds))
    return tuple(samples), tuple(failures)


def _sample_from(
    attempt: EncodeAttempt,
    contract: FormatContract,
    sample_seconds: float | None,
) -> SampleEncode:
    scope = (
        "whole file"
        if contract.media_kind == "image" or sample_seconds is None
        else f"first {sample_seconds:g}s"
    )
    quality = evaluate_metrics(
        contract,
        attempt.measurements,
        decoded_successfully=True,
        sampling_scope=scope,
        warnings=attempt.warnings,
    )
    assert attempt.candidate_path is not None and attempt.candidate_bytes is not None
    return SampleEncode(
        source_path=attempt.source_path,
        candidate_path=attempt.candidate_path,
        source_bytes=attempt.source_bytes,
        candidate_bytes=attempt.candidate_bytes,
        size_reduction_ratio=attempt.size_reduction_ratio or 0.0,
        quality=quality,
        sampling_scope=scope,
        warnings=attempt.warnings,
    )


def _build_projection(
    *,
    contract: FormatContract,
    supported: Sequence[PreviewItem],
    unsupported: Sequence[PreviewItem],
    samples: Sequence[SampleEncode],
    failures: Sequence[str],
    plan: SamplePlan,
) -> OptimizationProjection:
    ratios = [sample.size_reduction_ratio for sample in samples]
    measured_by_path = {sample.source_path: sample for sample in samples}
    mean_ratio = statistics.fmean(ratios) if ratios else None
    quality_setting = _quality_setting(contract)
    validation_method = _validation_method(contract)

    projections = [
        _project_item(
            item,
            contract=contract,
            mean_ratio=mean_ratio,
            sample=measured_by_path.get(item.path),
            quality_setting=quality_setting,
            validation_method=validation_method,
        )
        for item in supported
    ]
    projections += [
        ItemProjection(
            path=item.path,
            current_bytes=item.size_bytes,
            projected_low_bytes=None,
            projected_high_bytes=None,
            estimated_saving_bytes=None,
            confidence="unknown",
            output_container=contract.output_container,
            output_codec=contract.output_codec,
            quality_setting=quality_setting,
            validation_method=validation_method,
            compatibility_warnings=contract.compatibility_warnings,
            temporary_space_bytes=0,
            quarantine_space_bytes=0,
            recommendation="blocked",
            reason=f"{item.path.suffix or 'this format'} is not covered by {contract.contract_id}",
        )
        for item in unsupported
    ]

    recommended = [item for item in projections if item.recommendation == "optimize"]
    lows = [
        item.projected_low_bytes for item in recommended if item.projected_low_bytes is not None
    ]
    highs = [
        item.projected_high_bytes for item in recommended if item.projected_high_bytes is not None
    ]
    savings = [
        item.estimated_saving_bytes
        for item in recommended
        if item.estimated_saving_bytes is not None
    ]

    warnings: list[str] = []
    if plan.skipped_reason:
        warnings.append(plan.skipped_reason)
    warnings.extend(plan.excluded)
    if not samples:
        warnings.append(
            "No representative encode was produced, so every figure below is an estimate."
        )
    elif any(sample.quality.passed is not True for sample in samples):
        warnings.append(
            "At least one sample did not meet its contract; execution validates every output again."
        )

    return OptimizationProjection(
        contract_id=contract.contract_id,
        mode=contract.mode,
        output_container=contract.output_container,
        output_codec=contract.output_codec,
        item_count=len(projections),
        current_bytes=sum(item.size_bytes for item in supported),
        projected_low_bytes=sum(lows) if lows else None,
        projected_high_bytes=sum(highs) if highs else None,
        estimated_saving_bytes=sum(savings) if savings else None,
        confidence=_aggregate_confidence(projections),
        recommended_count=len(recommended),
        skipped_count=sum(1 for item in projections if item.recommendation == "skip"),
        blocked_count=sum(1 for item in projections if item.recommendation == "blocked"),
        temporary_space_bytes=max((item.temporary_space_bytes for item in recommended), default=0),
        quarantine_space_bytes=sum(item.quarantine_space_bytes for item in recommended),
        samples=tuple(samples),
        items=tuple(projections),
        warnings=tuple(warnings),
        compatibility_warnings=contract.compatibility_warnings,
        failures=tuple(failures),
    )


def _project_item(
    item: PreviewItem,
    *,
    contract: FormatContract,
    mean_ratio: float | None,
    sample: SampleEncode | None,
    quality_setting: str,
    validation_method: str,
) -> ItemProjection:
    """One item's projection, at the strongest confidence its evidence allows."""
    low: int | None
    high: int | None
    if sample is not None:
        low = high = sample.candidate_bytes
        confidence: Confidence = "measured"
        reason = f"this exact file was encoded ({sample.sampling_scope})"
    elif mean_ratio is not None:
        low_ratio = min(mean_ratio * (1 + SAMPLED_SPREAD), 0.95)
        high_ratio = max(mean_ratio * (1 - SAMPLED_SPREAD), -0.5)
        low = int(item.size_bytes * (1 - low_ratio))
        high = int(item.size_bytes * (1 - high_ratio))
        confidence = "sampled"
        reason = "projected from representative encodes of this library"
    else:
        low = high = None
        confidence = "unknown"
        reason = "no representative encode succeeded, so no saving can be claimed"

    saving = None if low is None or high is None else item.size_bytes - (low + high) // 2
    recommendation, reason = _recommend(
        saving=saving,
        confidence=confidence,
        reason=reason,
        sample=sample,
    )
    return ItemProjection(
        path=item.path,
        current_bytes=item.size_bytes,
        projected_low_bytes=low,
        projected_high_bytes=high,
        estimated_saving_bytes=saving,
        confidence=confidence,
        output_container=contract.output_container,
        output_codec=contract.output_codec,
        quality_setting=quality_setting,
        validation_method=validation_method,
        compatibility_warnings=contract.compatibility_warnings,
        # Optimization stages the candidate next to the original, so the peak
        # temporary cost is one original plus its worst-case output.
        temporary_space_bytes=item.size_bytes + (high or item.size_bytes),
        quarantine_space_bytes=item.size_bytes,
        recommendation=recommendation,
        reason=reason,
        sample_source_path=None if sample is None else sample.source_path,
    )


def _recommend(
    *,
    saving: int | None,
    confidence: Confidence,
    reason: str,
    sample: SampleEncode | None,
) -> tuple[Recommendation, str]:
    """Recommend skipping anything that cannot show it is worth doing.

    A projected size *increase* is the clearest case: re-encoding a file to make
    it bigger has no goal the user asked for, so it needs an explicit override.
    """
    # Growth is checked before contract failure because it is the more specific
    # answer: "this makes the file bigger" tells the user what to do, where "the
    # contract was not met" would only restate the size threshold it tripped.
    if saving is not None and saving <= 0:
        return "skip", "optimization is projected to make this file larger"
    if sample is not None and sample.quality.passed is False:
        return "blocked", "the representative encode did not meet its contract"
    if saving is None:
        return "skip", reason
    if confidence == "unknown":
        return "skip", reason
    return "optimize", reason


def _aggregate_confidence(items: Sequence[ItemProjection]) -> Confidence:
    """The aggregate is only as confident as its weakest contributing item."""
    order: tuple[Confidence, ...] = ("measured", "sampled", "estimated", "unknown")
    considered = [item for item in items if item.recommendation != "blocked"]
    if not considered:
        return "unknown"
    return max(considered, key=lambda item: order.index(item.confidence)).confidence


def _quality_setting(contract: FormatContract) -> str:
    if not contract.parameters:
        return "container defaults"
    return ", ".join(f"{key}={value}" for key, value in sorted(contract.parameters.items()))


def _validation_method(contract: FormatContract) -> str:
    return "; ".join(
        f"{metric.name} {metric.comparison.replace('_', ' ')} {metric.threshold}"
        for metric in contract.metrics
    )


def _empty_projection(
    contract: FormatContract,
    items: Sequence[PreviewItem],
    *,
    reason: str,
) -> OptimizationProjection:
    return OptimizationProjection(
        contract_id=contract.contract_id,
        mode=contract.mode,
        output_container=contract.output_container,
        output_codec=contract.output_codec,
        item_count=len(items),
        current_bytes=sum(item.size_bytes for item in items),
        projected_low_bytes=None,
        projected_high_bytes=None,
        estimated_saving_bytes=None,
        confidence="unknown",
        recommended_count=0,
        skipped_count=0,
        blocked_count=len(items),
        temporary_space_bytes=0,
        quarantine_space_bytes=0,
        warnings=(reason,),
        compatibility_warnings=contract.compatibility_warnings,
    )
