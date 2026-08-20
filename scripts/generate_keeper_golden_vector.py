#!/usr/bin/env python3
"""Freeze the keeper-selection golden vector into a machine-readable contract.

One generator, one artifact. `services/keeper_policies.py` decides, and both the
backend test and `lib/__tests__/keeperParity.test.ts` compare against
``contracts/keeper-golden-vector.json`` rather than restating the tie-breaks —
restating them is exactly how two implementations of one rule drift apart (A-02).

    python scripts/generate_keeper_golden_vector.py            # regenerate
    python scripts/generate_keeper_golden_vector.py --check    # CI gate
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "contracts" / "keeper-golden-vector.json"


def _shown(path: Path) -> str:
    """Repo-relative when it is in the repo — `--artifact` may point anywhere."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def render() -> str:
    """Serialize the vector exactly as it is written to disk."""
    sys.path.insert(0, str(ROOT / "backend"))
    from app.services.keeper_golden_vector import vector_payload

    return json.dumps(vector_payload(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed artifact does not match the Python implementation",
    )
    parser.add_argument("--artifact", type=Path, default=ARTIFACT)
    args = parser.parse_args()

    expected = render()
    artifact: Path = args.artifact

    if not args.check:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(expected, encoding="utf-8")
        print(f"wrote {_shown(artifact)}")
        return 0

    if not artifact.is_file():
        print(f"ERROR: {artifact} does not exist; run this script without --check")
        return 1
    if artifact.read_text(encoding="utf-8") != expected:
        print(
            f"ERROR: {_shown(artifact)} is stale.\n"
            "The keeper rules changed without regenerating the vector, so the "
            "frontend parity test is comparing against yesterday's answer.\n"
            "Run: python scripts/generate_keeper_golden_vector.py"
        )
        return 1
    print(f"{_shown(artifact)} matches the implementation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
