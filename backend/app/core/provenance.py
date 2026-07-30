"""Bounded, presentation-neutral explanation attached to planned actions."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DateRejectionReason = Literal[
    "absent",
    "unparseable",
    "sentinel_value",
    "suspicious",
    "overridden",
]


class DateCandidateProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    source: str = Field(min_length=1, max_length=64)
    value: str | None = None
    accepted: bool
    rejection_reason: DateRejectionReason | None = None


class DateResolutionProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    resolved_date: str | None = None
    winning_source: str | None = None
    candidates: tuple[DateCandidateProvenance, ...] = Field(default=(), max_length=8)


class RuleMatchProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str = Field(min_length=1, max_length=200)
    priority: int
    saved_order: int = Field(ge=0)


class RulesProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    matched_tags: tuple[RuleMatchProvenance, ...] = Field(default=(), max_length=16)
    winning_route: RuleMatchProvenance | None = None
    route_folder: str | None = None


class CategorizationProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    enabled: bool
    label: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    threshold: float | None = Field(default=None, ge=0, le=1)
    passed: bool | None = None


class DuplicateProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    evaluated: bool
    status: Literal["unique", "duplicate", "unknown", "not_evaluated"]
    match_kind: str | None = None
    matched_path: str | None = None
    perceptual_distance: int | None = Field(default=None, ge=0)


class MediaUnitProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    unit_id: str
    role: str
    members: tuple[str, ...] = Field(default=(), max_length=32)


class PathSegmentProvenance(BaseModel):
    model_config = ConfigDict(frozen=True)

    segment: str
    decision: Literal[
        "date",
        "category",
        "source_subfolder",
        "camera",
        "route",
        "rename",
        "conversion",
        "collision",
        "quarantine",
        "original_name",
    ]
    detail: str


class OutcomeProvenance(BaseModel):
    """The explanation recorded while the outcome is decided.

    Limits are deliberate: this object can be attached to every action in a
    generated million-file plan without turning into an evaluation log.
    """

    model_config = ConfigDict(frozen=True)

    date: DateResolutionProvenance
    rules: RulesProvenance = RulesProvenance()
    categorization: CategorizationProvenance
    duplicate: DuplicateProvenance
    unit: MediaUnitProvenance | None = None
    path: tuple[PathSegmentProvenance, ...] = Field(default=(), max_length=16)
