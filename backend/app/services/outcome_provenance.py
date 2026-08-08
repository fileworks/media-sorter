"""Pure construction of the explanation carried by preview and execution."""

from __future__ import annotations

import contextlib
from datetime import date
from pathlib import Path
from typing import Any, Literal, cast

from app.core.config import Config
from app.core.provenance import (
    CategorizationProvenance,
    DateCandidateProvenance,
    DateRejectionReason,
    DateResolutionProvenance,
    DuplicateProvenance,
    MediaUnitProvenance,
    OutcomeProvenance,
    PathSegmentProvenance,
    RuleMatchProvenance,
    RulesProvenance,
)
from app.services.ai.category_classifier_service import CategoryResult
from app.services.extraction_service import ExtractionResult


def build_outcome_provenance(
    *,
    file_path: Path,
    source_root: Path,
    destination: Path | None,
    config: Config,
    extraction: ExtractionResult,
    rules: Any | None,
    category: CategoryResult,
    duplicate_evaluated: bool,
    duplicate_type: str | None = None,
    duplicate_similarity: int | None = None,
    duplicate_of: str | None = None,
    duplicate_evaluation: str = "known",
    route_suffix: str | None = None,
    camera: str = "",
    unit_id: str | None = None,
    unit_role: str = "primary",
    unit_members: tuple[str, ...] = (),
) -> OutcomeProvenance:
    """Build from decisions already made; this function performs no media I/O."""
    candidates = tuple(
        DateCandidateProvenance(
            source=item.source,
            value=str(item.value) if item.value else None,
            accepted=item.accepted,
            rejection_reason=(None if item.accepted else cast(DateRejectionReason, item.reason)),
        )
        for item in extraction.candidates[:8]
    )
    tag_rules = tuple(
        RuleMatchProvenance(
            name=match.name,
            priority=match.priority,
            saved_order=match.saved_order,
        )
        for match in (getattr(rules, "matched_tag_rules", ()) or ())[:16]
    )
    route_match = getattr(rules, "matched_route_rule", None)
    route_matches = tuple(
        RuleMatchProvenance(
            name=match.name,
            priority=match.priority,
            saved_order=match.saved_order,
        )
        for match in (getattr(rules, "matched_route_rules", ()) or ())[:16]
    )
    if not duplicate_evaluated:
        duplicate_status: Literal["unique", "duplicate", "unknown", "not_evaluated"] = (
            "not_evaluated"
        )
    elif duplicate_evaluation == "unknown":
        duplicate_status = "unknown"
    elif duplicate_of:
        duplicate_status = "duplicate"
    else:
        duplicate_status = "unique"

    return OutcomeProvenance(
        date=DateResolutionProvenance(
            resolved_date=(
                str(extraction.extracted_date) if extraction.extracted_date is not None else None
            ),
            winning_source=extraction.source if extraction.extracted_date is not None else None,
            candidates=candidates,
        ),
        rules=RulesProvenance(
            matched_tags=tag_rules,
            matched_routes=route_matches,
            winning_route=(
                RuleMatchProvenance(
                    name=route_match.name,
                    priority=route_match.priority,
                    saved_order=route_match.saved_order,
                )
                if route_match is not None
                else None
            ),
            route_folder=route_suffix,
        ),
        categorization=CategorizationProvenance(
            enabled=config.categorize_enabled,
            label=category.category,
            confidence=category.confidence if config.categorize_enabled else None,
            threshold=config.categorize_confidence_threshold if config.categorize_enabled else None,
            passed=(category.category is not None) if config.categorize_enabled else None,
        ),
        duplicate=DuplicateProvenance(
            evaluated=duplicate_evaluated,
            status=duplicate_status,
            match_kind=duplicate_type,
            matched_path=duplicate_of,
            perceptual_distance=(
                100 - duplicate_similarity
                if duplicate_type == "perceptual" and duplicate_similarity is not None
                else None
            ),
        ),
        unit=(
            MediaUnitProvenance(
                unit_id=unit_id,
                role=unit_role,
                members=unit_members[:32],
            )
            if unit_id
            else None
        ),
        path=_path_segments(
            file_path=file_path,
            source_root=source_root,
            destination=destination,
            config=config,
            extracted_date=extraction.extracted_date,
            date_source=extraction.source,
            category=category.category,
            route_suffix=route_suffix,
            camera=camera,
        ),
    )


def append_collision(
    provenance: OutcomeProvenance,
    *,
    proposed: Path,
    reserved: Path,
) -> OutcomeProvenance:
    """Return the same explanation with the actual reservation decision."""
    if proposed == reserved:
        return provenance
    segment = PathSegmentProvenance(
        segment=reserved.name,
        decision="collision",
        detail=f"reserved after collision with {proposed.name}",
    )
    return provenance.model_copy(update={"path": (*provenance.path[:15], segment)})


def contextualize_copy(
    provenance: OutcomeProvenance,
    *,
    destination: Path,
    destination_root: Path,
    keeper: Path,
) -> OutcomeProvenance:
    """Attribute the actual keeper-relative path without borrowing the copy's date.

    A copy whose own metadata says 2021 can legitimately follow a keeper into
    2019. Reusing the ordinary date segments would therefore be a persuasive
    lie. Each inherited folder is explicitly attributed to the keeper instead.
    """
    try:
        relative = destination.relative_to(destination_root)
    except ValueError:
        relative = destination
    parts = relative.parts
    contextual = [
        PathSegmentProvenance(
            segment=segment,
            decision="quarantine",
            detail=f"follows kept copy {keeper.name}",
        )
        for segment in parts[:-1]
    ]
    if parts:
        contextual.append(
            PathSegmentProvenance(
                segment=parts[-1],
                decision="original_name",
                detail=f"named for kept copy {keeper.stem} and its source root",
            )
        )
    return provenance.model_copy(update={"path": tuple(contextual[:16])})


def _path_segments(
    *,
    file_path: Path,
    source_root: Path,
    destination: Path | None,
    config: Config,
    extracted_date: date | None,
    date_source: str,
    category: str | None,
    route_suffix: str | None,
    camera: str,
) -> tuple[PathSegmentProvenance, ...]:
    if destination is None:
        return ()
    segments: list[PathSegmentProvenance] = []
    quarantine = next((part for part in destination.parts if part.startswith("_")), None)
    if quarantine is not None:
        segments.append(
            PathSegmentProvenance(
                segment=quarantine,
                decision="quarantine",
                detail="planned outcome requires review outside the dated library",
            )
        )
    values = {
        "year": str(extracted_date.year) if extracted_date else "",
        "month": f"{extracted_date.month:02d}" if extracted_date else "",
        "day": f"{extracted_date.day:02d}" if extracted_date else "",
    }
    for criterion in config.sort_criteria:
        if segment := values.get(criterion):
            segments.append(
                PathSegmentProvenance(
                    segment=segment,
                    decision="date",
                    detail=f"{criterion} from {date_source}",
                )
            )
    if config.categorize_enabled:
        segments.append(
            PathSegmentProvenance(
                segment=category or "_uncategorized",
                decision="category",
                detail=(
                    "classifier passed its confidence threshold"
                    if category
                    else "classifier did not pass its confidence threshold"
                ),
            )
        )
    elif config.preserve_subfolders:
        with contextlib.suppress(ValueError):
            for part in file_path.parent.relative_to(source_root).parts:
                segments.append(
                    PathSegmentProvenance(
                        segment=part,
                        decision="source_subfolder",
                        detail="preserved from the input folder",
                    )
                )
    if config.camera_subfolder_enabled and camera:
        segments.append(
            PathSegmentProvenance(
                segment=camera,
                decision="camera",
                detail="camera identity from media metadata",
            )
        )
    if route_suffix:
        for part in Path(route_suffix).parts:
            segments.append(
                PathSegmentProvenance(
                    segment=part,
                    decision="route",
                    detail="winning route rule",
                )
            )

    if destination.suffix.casefold() != file_path.suffix.casefold():
        segments.append(
            PathSegmentProvenance(
                segment=destination.suffix,
                decision="conversion",
                detail=f"conversion changes {file_path.suffix} to {destination.suffix}",
            )
        )
    if config.rename:
        segments.append(
            PathSegmentProvenance(
                segment=destination.name,
                decision="rename",
                detail=(
                    f"rename pattern {config.rename_pattern!r} applied to original stem "
                    f"{file_path.stem!r}"
                ),
            )
        )
    else:
        segments.append(
            PathSegmentProvenance(
                segment=destination.name,
                decision="original_name",
                detail="original filename retained",
            )
        )
    return tuple(segments[:16])
