"""The backend half of the preview-status parity contract (A-06).

The frontend's `status` union is a TypeScript type, and types do not exist at
runtime — so nothing could ever have compared the two vocabularies. These tests
pin the backend side of the generated artifact both halves now read.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.core.review_status_contract import (
    CONTRACT_FORMAT_VERSION,
    NON_QUARANTINING_PREVIEW_STATUSES,
    PREVIEW_STATUSES,
    contract_payload,
)
from app.core.sort_plan import PLANNED_QUARANTINE_STATUSES

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = REPO_ROOT / "contracts" / "review-statuses.json"
GENERATOR = REPO_ROOT / "scripts" / "generate_review_status_contract.py"


@pytest.fixture(scope="module")
def artifact() -> dict[str, object]:
    parsed = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    return parsed


def test_the_artifact_carries_every_quarantining_status(artifact: dict[str, object]) -> None:
    """(a) Every backend quarantine status reaches the frontend contract."""
    assert artifact["planned_quarantine_statuses"] == sorted(PLANNED_QUARANTINE_STATUSES)


def test_the_two_halves_are_disjoint_and_cover_the_vocabulary() -> None:
    """A status either sends a file to a review folder or it does not."""
    assert not (PLANNED_QUARANTINE_STATUSES & NON_QUARANTINING_PREVIEW_STATUSES)
    assert PREVIEW_STATUSES == PLANNED_QUARANTINE_STATUSES | NON_QUARANTINING_PREVIEW_STATUSES


def test_the_non_quarantining_extras_are_exactly_the_four_reviewed_statuses() -> None:
    """(b) A fifth non-quarantining status needs a deliberate edit, not a merge."""
    assert NON_QUARANTINING_PREVIEW_STATUSES == frozenset(
        {"sort", "duplicate_unknown", "review_only", "keep_in_place"}
    )


def test_the_artifact_matches_the_module_it_was_generated_from(
    artifact: dict[str, object],
) -> None:
    assert artifact == dict(contract_payload())
    assert artifact["format_version"] == CONTRACT_FORMAT_VERSION


def test_the_committed_artifact_is_not_stale() -> None:
    """(c) The CI gate, run here too, so a stale artifact fails locally first."""
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_status_added_without_regenerating_fails_the_check(tmp_path: Path) -> None:
    """The gate's own regression test: acceptance criterion (2), mechanically.

    Adding a member to `PLANNED_QUARANTINE_STATUSES` without regenerating must
    fail. Simulated from the other side — a stale artifact is exactly what that
    omission produces, and mutating a frozenset constant in-process is not.
    """
    stale = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    stale["planned_quarantine_statuses"] = sorted(
        [*stale["planned_quarantine_statuses"], "newly_invented_status"]
    )
    stale_path = tmp_path / "review-statuses.json"
    stale_path.write_text(json.dumps(stale, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check", "--artifact", str(stale_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "stale" in result.stdout


def test_a_missing_artifact_is_reported_rather_than_ignored(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check", "--artifact", str(tmp_path / "absent.json")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "does not exist" in result.stdout
