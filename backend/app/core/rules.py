"""Typed, versioned deterministic tagging and routing rules."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

NumericOperator = Literal["eq", "gt", "lt", "gte", "lte"]

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def normalized_key(value: str) -> str:
    """Return the comparison key used for labels and filename rules."""
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def validate_relative_route(value: str) -> str:
    """Validate and return a portable slash-separated relative route.

    Values are rejected, never sanitized. Checks cover POSIX and Windows path
    interpretations so a rule created on one platform cannot escape its normal
    destination base after the config is moved to another.
    """
    if value != value.strip() or not value:
        raise ValueError("route.empty")
    if "\\" in value:
        raise ValueError("route.separator")
    if _CONTROL_RE.search(value):
        raise ValueError("route.control_character")
    if value.startswith(("/", "//")):
        raise ValueError("route.absolute")
    if PureWindowsPath(value).is_absolute() or PureWindowsPath(value).drive:
        raise ValueError("route.drive_or_unc")

    parts = value.split("/")
    if any(not part for part in parts):
        raise ValueError("route.empty_segment")
    for part in parts:
        if part in {".", ".."}:
            raise ValueError("route.dot_segment")
        if part.endswith((" ", ".")):
            raise ValueError("route.trailing_character")
        stem = part.split(".", 1)[0].upper()
        if stem in _WINDOWS_RESERVED:
            raise ValueError("route.reserved_name")
        if any(char in part for char in '<>:"|?*'):
            raise ValueError("route.reserved_character")
    return "/".join(parts)


def append_contained_route(base: Path, relative_folder: str) -> Path:
    """Append a validated route and prove lexical containment beneath *base*."""
    route = validate_relative_route(relative_folder)
    candidate = base.joinpath(*PurePosixPath(route).parts)
    base_resolved = base.resolve(strict=False)
    candidate_resolved = candidate.resolve(strict=False)
    try:
        candidate_resolved.relative_to(base_resolved)
    except ValueError as exc:  # pragma: no cover - defense after strict parsing
        raise ValueError("route.outside_base") from exc
    return candidate


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExtensionCondition(StrictModel):
    type: Literal["extension"]
    value: str

    @field_validator("value")
    @classmethod
    def normalize_extension(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFKC", value.strip()).casefold()
        if normalized.startswith("."):
            normalized = normalized[1:]
        if not normalized or normalized.startswith(".") or "/" in normalized or "\\" in normalized:
            raise ValueError("condition.extension.invalid")
        return normalized


class FilenameContainsCondition(StrictModel):
    type: Literal["filename_contains"]
    value: str

    @field_validator("value")
    @classmethod
    def require_value(cls, value: str) -> str:
        if not normalized_key(value):
            raise ValueError("condition.filename_contains.empty")
        return value


class SizeCondition(StrictModel):
    type: Literal["size"]
    operator: NumericOperator = "eq"
    value: int = Field(ge=0)


class ResolutionCondition(StrictModel):
    type: Literal["resolution"]
    operator: NumericOperator = "eq"
    width: int = Field(gt=0)
    height: int = Field(gt=0)


Condition = Annotated[
    ExtensionCondition | FilenameContainsCondition | SizeCondition | ResolutionCondition,
    Field(discriminator="type"),
]
CONDITION_ADAPTER: TypeAdapter[Condition] = TypeAdapter(Condition)


class RuleBase(StrictModel):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    priority: int = Field(default=0, ge=0, le=1_000_000)
    condition: Condition

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("rule.name.empty")
        return value


class TagRule(RuleBase):
    tag: str = Field(min_length=1, max_length=200)

    @field_validator("tag")
    @classmethod
    def require_tag(cls, value: str) -> str:
        if not normalized_key(value):
            raise ValueError("rule.tag.empty")
        return value


class RouteRule(RuleBase):
    relative_folder: str

    @field_validator("relative_folder")
    @classmethod
    def safe_route(cls, value: str) -> str:
        return validate_relative_route(value)


class RuleSet(StrictModel):
    version: Literal[1] = 1
    tag_rules: list[TagRule] = Field(default_factory=list)
    route_rules: list[RouteRule] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_ids(self) -> RuleSet:
        ids = [rule.id for rule in [*self.tag_rules, *self.route_rules]]
        if len(ids) != len(set(ids)):
            raise ValueError("rule.duplicate_id")
        return self


def _legacy_condition(raw: object) -> Condition:
    if not isinstance(raw, dict):
        raise ValueError("legacy.condition.invalid")
    condition = dict(raw)
    condition_type = condition.get("type")
    aliases = {
        "filename": "filename_contains",
        "filename-contains": "filename_contains",
        "file_size": "size",
        "dimensions": "resolution",
    }
    condition["type"] = aliases.get(str(condition_type), condition_type)
    operator_aliases = {">": "gt", "<": "lt", ">=": "gte", "<=": "lte", "=": "eq"}
    if "operator" in condition:
        condition["operator"] = operator_aliases.get(
            str(condition["operator"]), condition["operator"]
        )
    if condition.get("type") == "resolution" and "value" in condition:
        value = str(condition.pop("value"))
        try:
            width, height = (int(part) for part in value.casefold().split("x", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("legacy.resolution.invalid") from exc
        condition["width"] = width
        condition["height"] = height
    return CONDITION_ADAPTER.validate_python(condition)


def migrate_legacy_rules(raw_rules: object) -> tuple[RuleSet, list[str]]:
    """Convert representable legacy tag rules and report skipped entries."""
    if not isinstance(raw_rules, list):
        return RuleSet(), ["rules.legacy_not_list"]
    migrated: list[TagRule] = []
    warnings: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_rules):
        try:
            if not isinstance(raw, dict):
                raise ValueError("legacy.rule.invalid")
            rule_id = str(raw.get("id") or f"legacy-{index + 1}")
            if rule_id in seen:
                raise ValueError("legacy.rule.duplicate_id")
            seen.add(rule_id)
            migrated.append(
                TagRule(
                    id=rule_id,
                    name=str(raw.get("name") or rule_id),
                    enabled=bool(raw.get("enabled", True)),
                    priority=len(migrated),
                    condition=_legacy_condition(raw.get("condition")),
                    tag=str(raw["tag"]),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            warnings.append(f"rules.legacy_skipped:{index}:{exc}")
    return RuleSet(tag_rules=migrated), warnings
