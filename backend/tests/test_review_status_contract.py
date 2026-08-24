"""The backend half of the preview-status parity contract (A-06).

The frontend's `status` union is a TypeScript type, and types do not exist at
runtime — so nothing could ever have compared the two vocabularies. These tests
pin the backend side of the generated artifact both halves now read.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.core.review_status_contract import (
    CONTRACT_FORMAT_VERSION,
    NON_QUARANTINING_PREVIEW_STATUSES,
    OPERATION_RECORD_STATUSES,
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


# --------------------------------------------------------------------------- #
# The executor's record vocabulary                                             #
# --------------------------------------------------------------------------- #
#
# A preview status says where a file *would* go; a record status says what
# actually happened to it. The report screen filters on the second, and it had
# no contract — so a status the executor wrote and the filter did not know
# about vanished from every tab while still counting toward "All".


def test_the_artifact_carries_every_record_status(artifact: dict[str, object]) -> None:
    assert artifact["operation_record_statuses"] == sorted(OPERATION_RECORD_STATUSES)


def test_every_status_the_executor_writes_is_declared() -> None:
    """The literals in the executor must all be in the exported vocabulary.

    Hand-maintaining the set is only safe if forgetting to extend it fails
    here. `status="..."` and `record["status"] = "..."` are the two shapes the
    service uses to stamp a record.
    """
    source = (
        Path(__file__).resolve().parents[1] / "app" / "services" / "sorting_service.py"
    ).read_text(encoding="utf-8")
    written = set(re.findall(r'status="([a-z_]+)"', source))
    written |= set(re.findall(r'\["status"\]\s*=\s*"([a-z_]+)"', source))
    # `status="ok"`-style literals belong to unrelated payloads (probes and
    # capability reports), so only compare the ones that are record statuses.
    undeclared = {
        status
        for status in written
        if status not in OPERATION_RECORD_STATUSES and status in _RECORD_STATUS_CANDIDATES
    }
    assert undeclared == set(), (
        f"the executor writes {sorted(undeclared)} but the contract does not declare them; "
        "the report filter will drop those rows from every tab"
    )


#: Statuses observed on record dicts. Anything the executor stamps that is not
#: listed here is an unrelated payload field, not a file outcome.
_RECORD_STATUS_CANDIDATES = {
    "already_in_destination",
    "blocked",
    "cancelled",
    "companion_left_in_place",
    "corrupted",
    "duplicate",
    "failed",
    "future_date",
    "incomplete_unit",
    "junk",
    "kept_in_place",
    "success",
    "unknown_date",
}
