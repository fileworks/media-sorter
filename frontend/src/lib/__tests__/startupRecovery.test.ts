import { describe, expect, it } from "vitest";

import {
  buildRecoveryPlan,
  classify,
  startBlock,
  type RecoveryArtifact,
  type RecoveryOperation,
} from "@/lib/startupRecovery";

function artifact(overrides: Partial<RecoveryArtifact> = {}): RecoveryArtifact {
  return {
    action_id: "act1",
    kind: "stage",
    path: "/dest/.mediasort-stage/act1.tmp",
    verified: false,
    redundant: true,
    ...overrides,
  };
}

function operation(overrides: Partial<RecoveryOperation> = {}): RecoveryOperation {
  return {
    operation_id: "op1",
    started_at: "2026-07-20T10:00:00Z",
    state: "reconciliation_required",
    artifacts: [artifact()],
    ...overrides,
  };
}

describe("classify", () => {
  it("discards only a staged copy whose content exists elsewhere", () => {
    expect(classify(artifact()).classification).toBe("safe_to_discard");
    expect(classify(artifact({ redundant: false })).classification).toBe("needs_decision");
  });

  it("keeps a verified result and a verified original without asking", () => {
    expect(classify(artifact({ kind: "result", verified: true })).classification).toBe(
      "safe_to_keep",
    );
    expect(classify(artifact({ kind: "original", verified: true })).classification).toBe(
      "safe_to_keep",
    );
  });

  it("asks about anything it could not match to a verified copy", () => {
    const classified = classify(artifact({ kind: "result", verified: false, redundant: false }));

    expect(classified.classification).toBe("needs_decision");
    expect(classified.explanation).toMatch(/until you decide/i);
  });

  it("treats a quarantined file as safe and restorable", () => {
    expect(classify(artifact({ kind: "quarantined" })).explanation).toMatch(/restored/i);
  });
});

describe("buildRecoveryPlan", () => {
  it("splits automatic resolutions from decisions", () => {
    const plan = buildRecoveryPlan(
      operation({
        artifacts: [
          artifact(),
          artifact({ action_id: "act2", kind: "result", verified: false, redundant: false }),
        ],
      }),
    );

    expect(plan.automatic).toHaveLength(1);
    expect(plan.decisions).toHaveLength(1);
    expect(plan.blocksNewOperations).toBe(true);
    expect(plan.headline).toMatch(/1 item .* needs your decision/);
  });

  it("says nothing was deleted whenever a decision is pending", () => {
    const plan = buildRecoveryPlan(
      operation({ artifacts: [artifact({ redundant: false })] }),
    );

    expect(plan.guidance).toMatch(/nothing was deleted/i);
  });

  it("does not block when everything reconciled itself", () => {
    const plan = buildRecoveryPlan(operation());

    expect(plan.blocksNewOperations).toBe(false);
    expect(plan.guidance).toMatch(/no files were lost/i);
  });
});

describe("startBlock", () => {
  it("blocks new work only while a decision is outstanding", () => {
    const blocked = startBlock([operation({ artifacts: [artifact({ redundant: false })] })]);

    expect(blocked.blocked).toBe(true);
    expect(blocked.operationId).toBe("op1");
  });

  it("lets a cleanly reconciled operation out of the way", () => {
    expect(startBlock([operation()]).blocked).toBe(false);
  });

  it("ignores operations that are not awaiting reconciliation", () => {
    const finished = operation({ state: "completed", artifacts: [artifact({ redundant: false })] });

    expect(startBlock([finished]).blocked).toBe(false);
  });

  it("is not blocked by an empty list", () => {
    expect(startBlock([]).blocked).toBe(false);
  });
});
