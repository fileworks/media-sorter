import { describe, expect, it } from "vitest";

import {
  INITIAL_STATE,
  availableStages,
  goTo,
  isStale,
  readiness,
  reconcile,
  selectView,
  type StageInputs,
} from "@/lib/stageModel";

// ── Stage model ──────────────────────────────────────────────────────────────

const READY: StageInputs = {
  rootsReady: true,
  rootsReason: null,
  scanned: true,
  planned: true,
  plannedReason: null,
  blocked: false,
  blockedReason: null,
};

describe("stage readiness", () => {
  it("lets Sources be entered always", () => {
    expect(readiness("sources", { ...READY, rootsReady: false }).canEnter).toBe(true);
  });

  it("lets Configure be entered as soon as the folders are usable", () => {
    expect(readiness("configure", { ...READY, planned: false }).canEnter).toBe(true);
    expect(readiness("configure", { ...READY, rootsReady: false }).reason).toMatch(
      /input folder/i,
    );
  });

  it("blocks Review until the folders are chosen and a plan exists", () => {
    expect(readiness("review", { ...READY, rootsReady: false }).reason).toMatch(/input folder/i);
    expect(readiness("review", { ...READY, planned: false }).canEnter).toBe(false);
  });

  it("blocks Execute until a plan has been calculated", () => {
    expect(readiness("execute", { ...READY, planned: false }).canEnter).toBe(false);
  });

  it("reports a hard block ahead of a missing prerequisite", () => {
    const result = readiness("execute", {
      ...READY,
      rootsReady: false,
      blocked: true,
      blockedReason: "An interrupted run needs your decision.",
    });

    expect(result.reason).toMatch(/interrupted run/i);
  });

  it("lists exactly the stages that can be entered", () => {
    expect(availableStages(READY)).toEqual(["sources", "configure", "review", "execute"]);
    expect(availableStages({ ...READY, planned: false })).toEqual(["sources", "configure"]);
    expect(availableStages({ ...READY, rootsReady: false })).toEqual(["sources"]);
  });
});

describe("stage transitions", () => {
  const atExecute = { ...INITIAL_STATE, stage: "execute" as const };

  it("says what going back to Sources invalidates", () => {
    const transition = goTo(atExecute, "sources");

    expect(transition.state.stage).toBe("sources");
    expect(transition.invalidated.join(" ")).toMatch(/makes the current review stale/i);
    expect(transition.invalidated.join(" ")).toMatch(/frozen plan/i);
  });

  it("says that going back to Configure also makes the review stale", () => {
    const transition = goTo({ ...INITIAL_STATE, stage: "review" as const }, "configure");

    expect(transition.invalidated.join(" ")).toMatch(/changing settings/i);
  });

  it("invalidates nothing when moving forward", () => {
    expect(goTo(INITIAL_STATE, "configure").invalidated).toEqual([]);
    expect(goTo(INITIAL_STATE, "review").invalidated).toEqual([]);
  });

  it("falls back to the stage's first view for an invalid one", () => {
    expect(goTo(INITIAL_STATE, "review", "junk").state.view).toBe("junk");
    expect(goTo(INITIAL_STATE, "sources", "junk").state.view).toBe("overview");
  });

  it("refuses a view the current stage does not have", () => {
    const state = { ...INITIAL_STATE, stage: "sources" as const };

    expect(selectView(state, "warnings")).toBe(state);
  });
});

describe("stage reconciliation", () => {
  const key = { profileId: "p1", catalogGeneration: 3, planVersion: 2, taskId: null };

  it("hydrates a fresh shell without leaving Sources", () => {
    expect(reconcile(INITIAL_STATE, key)).toEqual({
      state: { ...INITIAL_STATE, key },
      invalidated: [],
    });
  });

  it("keeps state that still matches the world", () => {
    const state = { ...INITIAL_STATE, key };

    expect(isStale(state, key)).toBe(false);
    expect(reconcile(state, key).invalidated).toEqual([]);
  });

  it("returns to Review and explains every reason", () => {
    const state = { ...INITIAL_STATE, stage: "execute" as const, key };

    const transition = reconcile(state, { ...key, catalogGeneration: 4, planVersion: 3 });

    expect(transition.state.stage).toBe("review");
    expect(transition.state.view).toBe("duplicates");
    expect(transition.invalidated).toHaveLength(2);
  });

  it("says nothing when the first scan and the first plan simply arrive", () => {
    const fresh = { profileId: "p1", catalogGeneration: 0, planVersion: 0, taskId: null };
    const state = { ...INITIAL_STATE, stage: "configure" as const, key: fresh };

    const transition = reconcile(state, { ...fresh, catalogGeneration: 1, planVersion: 1 });

    expect(transition.invalidated).toEqual([]);
    expect(transition.state.stage).toBe("review");
  });

  it("lands on Configure when the plan is gone rather than on an empty Review", () => {
    const state = { ...INITIAL_STATE, stage: "execute" as const, key };

    const transition = reconcile(state, { ...key, planVersion: 0 });

    expect(transition.state.stage).toBe("configure");
  });

  it("notices a different profile", () => {
    const state = { ...INITIAL_STATE, key };

    expect(reconcile(state, { ...key, profileId: "p2" }).invalidated[0]).toMatch(/profile/i);
  });
});
