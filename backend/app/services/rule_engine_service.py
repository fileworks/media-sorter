"""Typed deterministic tag and route rule evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.core.config import Config
from app.core.rules import (
    ExtensionCondition,
    FilenameContainsCondition,
    NumericOperator,
    ResolutionCondition,
    RouteRule,
    SizeCondition,
    TagRule,
    normalized_key,
)
from app.services.filesystem_service import image_dimensions


@dataclass(frozen=True)
class MatchedRule:
    name: str
    priority: int
    saved_order: int


@dataclass(frozen=True)
class RuleEvaluation:
    tags: tuple[str, ...]
    route: str | None
    matched_tag_rule_ids: tuple[str, ...]
    matched_route_rule_id: str | None
    matched_tag_rules: tuple[MatchedRule, ...] = ()
    matched_route_rule: MatchedRule | None = None
    matched_route_rules: tuple[MatchedRule, ...] = ()


_EMPTY = RuleEvaluation((), None, (), None)


class RuleEngineService:
    def __init__(self, config: Config) -> None:
        self._config = config

    def for_operation(self, config: Config) -> RuleEngineService:
        """Return a rule engine bound to an operation's immutable config snapshot."""
        return RuleEngineService(config)

    def evaluate_all(self, file_path: Path) -> RuleEvaluation:
        """Evaluate enabled rules against the untouched source file."""
        if not self._config.rules_enabled:
            return _EMPTY
        rule_set = self._config.rule_set
        tags: list[str] = []
        tag_ids: list[str] = []
        tag_matches: list[MatchedRule] = []
        seen_tags: set[str] = set()
        for saved_order, rule in sorted(
            enumerate(rule_set.tag_rules),
            key=lambda item: (item[1].priority, item[0]),
        ):
            if not rule.enabled or not self._matches(file_path, rule):
                continue
            key = normalized_key(rule.tag)
            if key not in seen_tags:
                seen_tags.add(key)
                tags.append(rule.tag)
            tag_ids.append(rule.id)
            tag_matches.append(MatchedRule(rule.name, rule.priority, saved_order))

        route_rule: RouteRule | None = None
        route_saved_order: int | None = None
        route_matches: list[MatchedRule] = []
        for saved_order, candidate in sorted(
            enumerate(rule_set.route_rules),
            key=lambda item: (item[1].priority, item[0]),
        ):
            if not candidate.enabled or not self._matches(file_path, candidate):
                continue
            route_matches.append(MatchedRule(candidate.name, candidate.priority, saved_order))
            if route_rule is None:
                route_rule = candidate
                route_saved_order = saved_order
        return RuleEvaluation(
            tags=tuple(tags),
            route=route_rule.relative_folder if route_rule else None,
            matched_tag_rule_ids=tuple(tag_ids),
            matched_route_rule_id=route_rule.id if route_rule else None,
            matched_tag_rules=tuple(tag_matches),
            matched_route_rule=(
                MatchedRule(route_rule.name, route_rule.priority, route_saved_order or 0)
                if route_rule is not None
                else None
            ),
            matched_route_rules=tuple(route_matches),
        )

    def evaluate(self, file_path: Path) -> list[str]:
        """Compatibility helper returning only tag-rule results."""
        return list(self.evaluate_all(file_path).tags)

    @staticmethod
    def _matches(path: Path, rule: TagRule | RouteRule) -> bool:
        condition = rule.condition
        if isinstance(condition, ExtensionCondition):
            return path.suffix.casefold().removeprefix(".") == condition.value
        if isinstance(condition, FilenameContainsCondition):
            return normalized_key(condition.value) in normalized_key(path.stem)
        if isinstance(condition, SizeCondition):
            try:
                return _compare(path.stat().st_size, condition.operator, condition.value)
            except OSError:
                return False
        if isinstance(condition, ResolutionCondition):
            dimensions = image_dimensions(path)
            if dimensions is None:
                return False
            width, height = dimensions
            return _compare(width, condition.operator, condition.width) and _compare(
                height, condition.operator, condition.height
            )
        return False


def _compare(actual: int, operator: NumericOperator, threshold: int) -> bool:
    if operator == "gt":
        return actual > threshold
    if operator == "lt":
        return actual < threshold
    if operator == "gte":
        return actual >= threshold
    if operator == "lte":
        return actual <= threshold
    return actual == threshold
