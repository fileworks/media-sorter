#!/usr/bin/env python3
"""Freeze the backend preview-status vocabulary into a machine-readable contract.

One generator, one artifact. The backend test, the frontend test and CI all read
``contracts/review-statuses.json`` rather than restating the vocabulary, because
restating it is precisely how `suspicious_date` came to be previewed into a
folder the plan authorized nothing for (see `app/core/sort_plan.py`).

    python scripts/generate_review_status_contract.py            # regenerate
    python scripts/generate_review_status_contract.py --check    # CI gate
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "contracts" / "review-statuses.json"


def render() -> str:
    """Serialize the contract exactly as it is written to disk."""
    # Import lazily and from the repository checkout, so the generator works
    # whether or not the backend package happens to be installed in the
    # interpreter running it.
    sys.path.insert(0, str(ROOT / "backend"))
    from app.core.review_status_contract import contract_payload

    return json.dumps(contract_payload(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed artifact does not match the backend vocabulary",
    )
    parser.add_argument("--artifact", type=Path, default=ARTIFACT)
    args = parser.parse_args()

    expected = render()
    artifact: Path = args.artifact

    if not args.check:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(expected, encoding="utf-8")
        print(f"wrote {artifact.relative_to(ROOT)}")
        return 0

    if not artifact.is_file():
        print(f"ERROR: {artifact} does not exist; run this script without --check")
        return 1

    actual = artifact.read_text(encoding="utf-8")
    if actual != expected:
        print(
            f"ERROR: {artifact.name} is stale.\n"
            "The backend preview-status vocabulary changed without regenerating the\n"
            "contract the frontend is pinned to. Run:\n"
            "    python scripts/generate_review_status_contract.py"
        )
        return 1

    print(f"{artifact.name} matches the backend vocabulary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
