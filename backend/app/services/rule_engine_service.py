"""Rule engine service — evaluate simple if/then tagging rules."""

from pathlib import Path
from typing import Any

from app.core.config import Config
from app.core.logging_config import get_logger

logger = get_logger(__name__)


class RuleEngineService:
    def __init__(self, config: Config) -> None:
        self._config = config

    def evaluate(self, file_path: Path) -> list[str]:
        """Return list of tags that apply to the given file."""
        if not self._config.rules_enabled:
            return []
        tags: list[str] = []
        for rule in self._config.rules:
            try:
                if self._matches(file_path, rule):
                    tags.append(rule.get("tag", ""))
            except Exception as exc:
                logger.warning("Rule evaluation failed", rule=rule, error=str(exc))
        return [t for t in tags if t]

    def _matches(self, path: Path, rule: dict[str, Any]) -> bool:
        condition = rule.get("condition", {})
        ctype = condition.get("type")
        operator = condition.get("operator", "eq")
        value = condition.get("value", "")

        if ctype == "extension":
            return path.suffix.lower().lstrip(".") == str(value).lower()

        if ctype == "filename_contains":
            return str(value) in path.stem

        if ctype == "size":
            try:
                file_size = path.stat().st_size
                threshold = int(value)
                return self._compare(file_size, operator, threshold)
            except (OSError, ValueError):
                return False

        if ctype == "resolution":
            return self._check_resolution(path, operator, str(value))

        return False

    @staticmethod
    def _compare(actual: int, operator: str, threshold: int) -> bool:
        if operator in ("gt", ">"):
            return actual > threshold
        if operator in ("lt", "<"):
            return actual < threshold
        if operator in ("gte", ">="):
            return actual >= threshold
        if operator in ("lte", "<="):
            return actual <= threshold
        return actual == threshold

    @staticmethod
    def _check_resolution(path: Path, operator: str, value: str) -> bool:
        """Compare image resolution. *value* is "WxH" e.g. "3840x2160".

        Both axes must satisfy the comparison independently — that way a
        5120×1440 ultrawide doesn't accidentally match a "≥ 4K UHD" rule
        just because total pixel count happens to be equal.
        """
        try:
            from PIL import Image

            tw, th = (int(x) for x in value.lower().split("x"))
            with Image.open(path) as img:
                w, h = img.size
            return RuleEngineService._compare(w, operator, tw) and RuleEngineService._compare(
                h, operator, th
            )
        except Exception:
            return False
