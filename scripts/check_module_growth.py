#!/usr/bin/env python3
"""Warn when reviewed high-change modules outgrow their documented seams."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POLICY = ROOT / "module-growth-policy.json"


def evaluate(policy_path: Path = DEFAULT_POLICY, *, root: Path = ROOT) -> list[str]:
    document: dict[str, Any] = json.loads(policy_path.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise ValueError("unsupported module-growth policy schema")
    reviewed = document.get("reviewed_modules")
    exemptions = document.get("static_catalogue_exemptions")
    if not isinstance(reviewed, list) or not isinstance(exemptions, list):
        raise ValueError("module-growth policy inventories must be lists")

    exempt_paths = {str(path) for path in exemptions}
    warnings: list[str] = []
    for raw in reviewed:
        if not isinstance(raw, dict):
            raise ValueError("reviewed module records must be objects")
        path_text = str(raw["path"])
        if path_text in exempt_paths:
            raise ValueError(f"reviewed module is also exempt: {path_text}")
        threshold = int(raw["warning_lines"])
        if threshold < 1:
            raise ValueError(f"invalid warning threshold for {path_text}")
        path = root / path_text
        if not path.is_file():
            raise ValueError(f"reviewed module does not exist: {path_text}")
        lines = len(path.read_text(encoding="utf-8").splitlines())
        print(f"{path_text}: {lines} lines (review at {threshold})")
        if lines > threshold:
            warnings.append(
                f"{path_text} has {lines} lines; review its documented ownership "
                f"before raising the {threshold}-line warning baseline"
            )
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    args = parser.parse_args()
    try:
        warnings = evaluate(args.policy.resolve())
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    for warning in warnings:
        print(f"WARNING: {warning}")
    # This is intentionally advisory. The checked-in baseline makes growth
    # visible without turning an arbitrary line count into a release failure.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
