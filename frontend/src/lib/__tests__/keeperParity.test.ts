import { describe, expect, it } from "vitest";

import vector from "../../../../contracts/keeper-golden-vector.json";
import { keeperByPolicy, type DuplicateGroup } from "@/lib/reviewWorkbench";
import type { KeeperPolicyId } from "@/types/api";

/**
 * P1-ARCH-002 / A-02 — one keeper rule, two implementations, one answer.
 *
 * `keeperByPolicy` here and `keeper_policies.py` in the backend both decide
 * which copy survives: a person picks the rule in Review, and the backend
 * applies the same rule from Configure. Mirrored tie-breaks drift, and the
 * drift is invisible — both sides keep returning *a* keeper, just not the same
 * one.
 *
 * So neither side is asked to describe the rule twice. The vector is generated
 * from the Python implementation into `contracts/keeper-golden-vector.json`
 * (see `scripts/generate_keeper_golden_vector.py`, gated in CI with `--check`),
 * and this test asserts the TypeScript reproduces it. A change to either side
 * fails: the backend's own test catches a stale artifact, and a regenerated
 * artifact fails here until the TypeScript follows.
 *
 * Read as JSON rather than through `fs` for the same reason the review-status
 * contract is: this app has no `@types/node`.
 */
describe("keeper parity with the backend", () => {
  const cases = vector.cases as ReadonlyArray<{
    name: string;
    policy: string;
    preferred_roots: string[];
    group: unknown;
    keeper: string | null;
    outcome: string;
  }>;

  it("has a vector to compare against", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(vector.policies.length).toBeGreaterThan(0);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "agrees with the backend: %s",
    (_name, entry) => {
      const chosen = keeperByPolicy(entry.group as DuplicateGroup, entry.policy as KeeperPolicyId);

      expect(chosen).toBe(entry.keeper);
    },
  );

  /**
   * `preferred_root` needs a root order this interface never sets, so the
   * TypeScript declines it by construction. The vector pins that both sides
   * decline *the same input* — it is agreement, not an excused difference.
   */
  it("covers every policy the backend knows about", () => {
    const covered = new Set(cases.map((entry) => entry.policy));

    expect([...covered].sort()).toEqual([...vector.policies].sort());
  });

  it("pins refusals as firmly as choices", () => {
    const refusals = cases.filter((entry) => entry.keeper === null);

    expect(refusals.length).toBeGreaterThan(0);
    for (const entry of refusals) {
      expect(
        keeperByPolicy(entry.group as DuplicateGroup, entry.policy as KeeperPolicyId),
      ).toBeNull();
    }
  });
});
