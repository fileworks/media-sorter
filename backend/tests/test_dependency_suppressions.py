from __future__ import annotations

import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "validate_dependency_suppressions.py"
SPEC = importlib.util.spec_from_file_location("validate_dependency_suppressions", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
POLICY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POLICY
SPEC.loader.exec_module(POLICY)


def _write(path: Path, entry: dict[str, str]) -> None:
    path.write_text(
        json.dumps({"schema_version": 1, "suppressions": [entry]}),
        encoding="utf-8",
    )


def _entry() -> dict[str, str]:
    return {
        "advisory": "RUSTSEC-2026-0194",
        "created": "2026-07-01",
        "ecosystem": "rust",
        "evidence": (
            "The affected parser is not reachable from any user-controlled application input."
        ),
        "expires": "2026-08-01",
        "owner": "release-owner",
        "scope": "Cargo.lock",
    }


def test_checked_in_policy_has_no_stale_suppressions() -> None:
    entries = POLICY.load_policy(POLICY.DEFAULT_POLICY, today=date.fromisoformat("2026-07-29"))
    assert entries == []


def test_expired_suppression_fails_closed(tmp_path: Path) -> None:
    policy = tmp_path / "policy.json"
    entry = _entry()
    entry["expires"] = "2026-07-02"
    _write(policy, entry)

    with pytest.raises(POLICY.PolicyError, match="expired"):
        POLICY.load_policy(policy, today=date.fromisoformat("2026-07-03"))


def test_suppression_lifetime_is_bounded(tmp_path: Path) -> None:
    policy = tmp_path / "policy.json"
    entry = _entry()
    entry["expires"] = "2027-01-01"
    _write(policy, entry)

    with pytest.raises(POLICY.PolicyError, match="within 90 days"):
        POLICY.load_policy(policy, today=date.fromisoformat("2026-07-15"))


def test_suppression_requires_evidence_owner_and_scope(tmp_path: Path) -> None:
    for key in ("evidence", "owner", "scope"):
        policy = tmp_path / f"{key}.json"
        entry = _entry()
        entry[key] = ""
        _write(policy, entry)
        with pytest.raises(POLICY.PolicyError):
            POLICY.load_policy(policy, today=date.fromisoformat("2026-07-15"))
