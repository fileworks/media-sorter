from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType


def _module() -> ModuleType:
    path = Path(__file__).parents[2] / "scripts" / "check_module_growth.py"
    spec = importlib.util.spec_from_file_location("check_module_growth", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GROWTH = _module()


def test_checked_in_growth_policy_is_valid_and_below_review_warnings() -> None:
    assert GROWTH.evaluate() == []


def test_growth_is_advisory_and_static_catalogues_cannot_hide_reviewed_modules(
    tmp_path: Path,
) -> None:
    (tmp_path / "large.py").write_text("line\n" * 3, encoding="utf-8")
    policy = tmp_path / "policy.json"
    policy.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "reviewed_modules": [
                    {
                        "path": "large.py",
                        "owner": "test",
                        "rationale": "fixture",
                        "warning_lines": 2,
                    }
                ],
                "static_catalogue_exemptions": [],
            }
        ),
        encoding="utf-8",
    )

    assert len(GROWTH.evaluate(policy, root=tmp_path)) == 1
