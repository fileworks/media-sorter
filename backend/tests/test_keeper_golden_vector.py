"""P1-ARCH-002 / A-02 — one keeper rule, two implementations, one answer.

`services/keeper_policies.py` and `lib/reviewWorkbench.ts::keeperByPolicy` both
choose which copy survives. A user picks the rule in Review; the backend applies
it from Configure. If the tie-breaks drift, the same set yields different
keepers depending on which surface acted — and nothing would say so.

The vector is generated from the Python implementation and read by both suites.
These tests are the backend half: the artifact must describe what the code
actually does, and it must cover every policy that exists.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from app.core.duplicate_plans import KeeperPolicyId
from app.services.keeper_golden_vector import GOLDEN_POLICIES, vector_payload

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACT = REPO_ROOT / "contracts" / "keeper-golden-vector.json"
GENERATOR = REPO_ROOT / "scripts" / "generate_keeper_golden_vector.py"


def _committed() -> dict[str, Any]:
    """The artifact as committed. Typed loosely on purpose: this is the wire
    shape both languages read, not a model either of them owns."""
    payload: dict[str, Any] = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    return payload


class TestTheArtifactDescribesTheCode:
    def test_the_committed_vector_is_not_stale(self) -> None:
        """The one that fails when somebody changes a tie-break and forgets."""
        assert _committed() == vector_payload()

    def test_the_generator_agrees_from_a_clean_process(self) -> None:
        """Run the way CI runs it, not through this test's imports."""
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--check"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=120,
        )

        assert result.returncode == 0, result.stdout + result.stderr

    def test_a_changed_rule_makes_the_check_fail(self, tmp_path: Path) -> None:
        """Proves the gate can fail. A `--check` that always passes is not a gate."""
        stale = tmp_path / "stale.json"
        payload = vector_payload()
        payload["cases"][0]["keeper"] = "somebody-else"
        stale.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--check", "--artifact", str(stale)],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=120,
        )

        assert result.returncode == 1
        assert "stale" in result.stdout


class TestItCoversTheWholeVocabulary:
    def test_every_policy_id_has_at_least_one_case(self) -> None:
        covered = {case["policy"] for case in _committed()["cases"]}

        assert covered == set(GOLDEN_POLICIES)

    def test_the_vocabulary_is_the_type_and_not_a_copy_of_it(self) -> None:
        """A policy added to `KeeperPolicyId` without a case is a policy the two
        implementations may already disagree about, so this fails on the add."""
        declared = set(KeeperPolicyId.__args__)  # type: ignore[attr-defined]

        assert set(GOLDEN_POLICIES) == declared

    def test_both_a_decision_and_a_refusal_are_pinned(self) -> None:
        """A vector of only-decides would let a refusal drift silently."""
        outcomes = {case["outcome"] for case in _committed()["cases"]}

        assert {"decided", "needs_review"} <= outcomes
