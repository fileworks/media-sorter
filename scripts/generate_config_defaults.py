#!/usr/bin/env python3
"""Generate the frontend test-default contract from the backend Config.

Production reads ``GET /api/config/defaults``. Tests cannot call that endpoint
before the frontend exists, so they consume this generated snapshot instead of
restating concrete Python defaults in TypeScript.

    python scripts/generate_config_defaults.py
    python scripts/generate_config_defaults.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "contracts" / "config-defaults.json"


def render() -> str:
    """Serialize the backend-owned defaults exactly as committed."""
    sys.path.insert(0, str(ROOT / "backend"))
    from app.core.config import Config

    return json.dumps(
        {"schema_version": 1, "config": Config.defaults().to_dict()},
        indent=2,
        sort_keys=True,
    ) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--artifact", type=Path, default=ARTIFACT)
    args = parser.parse_args()
    artifact: Path = args.artifact
    expected = render()

    if not args.check:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(expected, encoding="utf-8")
        print(f"wrote {artifact.relative_to(ROOT)}")
        return 0
    if not artifact.is_file() or artifact.read_text(encoding="utf-8") != expected:
        print(
            f"ERROR: {artifact.name} is missing or stale. "
            "Run: python scripts/generate_config_defaults.py"
        )
        return 1
    print(f"{artifact.name} matches backend Config.defaults()")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
