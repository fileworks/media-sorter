"""Shared factual assessments used by Review validation and standalone audit."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ReadabilityAssessment:
    readable: bool
    evidence: str | None = None


@dataclass(frozen=True)
class PlacementAssessment:
    consistent: bool
    current_path: str
    expected_path: str


def assess_readability(path: Path) -> ReadabilityAssessment:
    """Classify only facts both validation entry points can observe equally."""
    try:
        if not path.is_file():
            return ReadabilityAssessment(False, "the file is missing")
        if path.stat().st_size <= 0:
            return ReadabilityAssessment(False, "the file is empty")
    except OSError as exc:
        return ReadabilityAssessment(False, f"{type(exc).__name__} while reading the file")
    return ReadabilityAssessment(True)


def assess_placement(
    current_path: str,
    expected_path: str,
    *,
    expected_is_prefix: bool = False,
) -> PlacementAssessment:
    """Compare normalized relative paths without either caller inventing rules."""
    current = Path(current_path).parts
    expected = Path(expected_path).parts
    consistent = current[: len(expected)] == expected if expected_is_prefix else current == expected
    return PlacementAssessment(
        consistent=consistent,
        current_path=Path(*current).as_posix(),
        expected_path=Path(*expected).as_posix(),
    )
