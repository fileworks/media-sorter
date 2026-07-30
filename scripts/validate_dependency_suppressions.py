#!/usr/bin/env python3
"""Validate narrowly-scoped, expiring dependency-audit suppressions."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLICY = REPO_ROOT / "dependency-audit-suppressions.json"
MAX_LIFETIME = timedelta(days=90)
ADVISORY_PATTERNS = {
    "python": re.compile(r"^(?:GHSA|PYSEC)-[A-Za-z0-9-]+$"),
    "rust": re.compile(r"^RUSTSEC-\d{4}-\d{4}$"),
}


class PolicyError(ValueError):
    pass


def load_policy(path: Path, *, today: date | None = None) -> list[dict[str, Any]]:
    observed_today = date.today() if today is None else today
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        entries = document["suppressions"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise PolicyError(f"cannot read dependency suppression policy: {exc}") from exc
    if document.get("schema_version") != 1 or not isinstance(entries, list):
        raise PolicyError("dependency suppression policy must use schema_version 1")

    seen: set[tuple[str, str, str]] = set()
    validated: list[dict[str, Any]] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise PolicyError(f"suppression {position} is not an object")
        ecosystem = entry.get("ecosystem")
        advisory = entry.get("advisory")
        scope = entry.get("scope")
        owner = entry.get("owner")
        evidence = entry.get("evidence")
        if ecosystem not in ADVISORY_PATTERNS:
            raise PolicyError(f"suppression {position} has unsupported ecosystem")
        if not isinstance(advisory, str) or not ADVISORY_PATTERNS[ecosystem].fullmatch(advisory):
            raise PolicyError(f"suppression {position} has an invalid advisory id")
        if not isinstance(scope, str) or not scope.strip():
            raise PolicyError(f"suppression {position} has no dependency-set scope")
        if not isinstance(owner, str) or len(owner.strip()) < 3:
            raise PolicyError(f"suppression {position} has no accountable owner")
        if not isinstance(evidence, str) or len(evidence.strip()) < 30:
            raise PolicyError(f"suppression {position} has insufficient evidence")
        try:
            created = date.fromisoformat(str(entry["created"]))
            expires = date.fromisoformat(str(entry["expires"]))
        except (KeyError, ValueError) as exc:
            raise PolicyError(f"suppression {position} has invalid dates") from exc
        if created > observed_today:
            raise PolicyError(f"suppression {advisory} was created in the future")
        if expires < observed_today:
            raise PolicyError(f"suppression {advisory} expired on {expires.isoformat()}")
        if expires <= created or expires - created > MAX_LIFETIME:
            raise PolicyError(f"suppression {advisory} must expire within {MAX_LIFETIME.days} days")
        key = (ecosystem, advisory, scope)
        if key in seen:
            raise PolicyError(f"duplicate suppression: {ecosystem}/{advisory}/{scope}")
        seen.add(key)
        validated.append(entry)
    return validated


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--ecosystem", choices=sorted(ADVISORY_PATTERNS))
    args = parser.parse_args(arguments)
    try:
        entries = load_policy(args.policy)
    except PolicyError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.check:
        print(f"dependency suppressions valid: {len(entries)} active")
    else:
        for entry in entries:
            if entry["ecosystem"] == args.ecosystem:
                print(entry["advisory"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
