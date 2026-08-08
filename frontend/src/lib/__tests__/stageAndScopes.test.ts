import { describe, expect, it } from "vitest";

import { splitValidation } from "@/lib/configGates";
import type { ConfigIssue } from "@/types/api";
import {
  INITIAL_STATE,
  availableStages,
  goTo,
  isStale,
  readiness,
  reconcile,
  selectView,
  stageIndex,
  type Stage,
  type StageInputs,
} from "@/lib/stageModel";

// ── Stage model ──────────────────────────────────────────────────────────────

const READY: StageInputs = {
  rootsReady: true,
  rootsReason: null,
  scanned: true,
  planned: true,
  plannedReason: null,
  duplicateReviewReady: true,
  duplicateReviewReason: null,
  blocked: false,
  blockedReason: null,
};

function issue(field: string | null, key: string): ConfigIssue {
  return { field, message: key, message_key: key, params: {} };
}

describe("validation routing", () => {
  it("routes a folder problem to Sources and everything else to Configure", () => {
    const split = splitValidation([
      issue("source_directory", "config.source.not_found"),
      issue("target_directory", "config.target.required"),
      issue("library_profile", "config.profile.invalid"),
      issue("preservation_profile", "config.integrity.authorization_required"),
      issue("min_file_size_kb", "config.filters.minimum_negative"),
    ]);

    expect(split.roots.map((entry) => entry.field)).toEqual([
      "source_directory",
      "target_directory",
      "library_profile",
    ]);
    expect(split.settings.map((entry) => entry.field)).toEqual([
      "preservation_profile",
      "min_file_size_kb",
    ]);
  });

  // The bug this routing exists for: a mutating setting under Organize Only is
  // a settings error, and reporting it on Sources told the user to choose
  // folders they had already chosen, on the screen that cannot fix it.
  it("never lets a settings error close the Sources gate", () => {
    const split = splitValidation([issue("preservation_profile", "config.integrity.x")]);

    expect(split.roots).toEqual([]);
    expect(
      readiness("configure", { ...READY, rootsReady: split.roots.length === 0 }).canEnter,
    ).toBe(true);
  });

  it("treats an error tied to no single field as a settings problem", () => {
    expect(splitValidation([issue(null, "config.validation.invalid")]).settings).toHaveLength(1);
  });
});

describe("stage readiness", () => {
  it("lets Sources be entered always", () => {
    expect(readiness("sources", { ...READY, rootsReady: false }).canEnter).toBe(true);
  });

  it("lets Configure be entered as soon as the folders are usable", () => {
    expect(readiness("configure", { ...READY, planned: false }).canEnter).toBe(true);
    expect(readiness("configure", { ...READY, rootsReady: false }).reason).toMatch(/input folder/i);
  });

  it("gates Recipe exactly as it gates Configure", () => {
    expect(readiness("recipe", { ...READY, planned: false }).canEnter).toBe(true);
    expect(readiness("recipe", { ...READY, rootsReady: false }).reason).toMatch(/input folder/i);
    expect(readiness("recipe", { ...READY, rootsReady: false }).canEnter).toBe(false);
  });

  it("lets Review host a plan being computed, but still requires usable folders", () => {
    expect(readiness("review", { ...READY, rootsReady: false }).reason).toMatch(/input folder/i);
    expect(readiness("review", { ...READY, planned: false }).canEnter).toBe(true);
  });

  it("blocks Execute until a plan has been calculated", () => {
    expect(readiness("execute", { ...READY, planned: false }).canEnter).toBe(false);
  });

  it("lets Review inspect proposals but blocks Execute until every set is decided", () => {
    const awaitingDuplicates = {
      ...READY,
      duplicateReviewReady: false,
      duplicateReviewReason: "3 duplicate sets still need a decision.",
    };

    expect(readiness("review", awaitingDuplicates).canEnter).toBe(true);
    expect(readiness("execute", awaitingDuplicates)).toEqual({
      canEnter: false,
      reason: "3 duplicate sets still need a decision.",
    });
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
    expect(availableStages(READY)).toEqual(["sources", "recipe", "configure", "review", "execute"]);
    expect(availableStages({ ...READY, planned: false })).toEqual([
      "sources",
      "recipe",
      "configure",
      "review",
    ]);
    expect(availableStages({ ...READY, rootsReady: false })).toEqual(["sources"]);
  });
});

describe("stage transitions", () => {
  // A plan actually exists; without one there is nothing to invalidate.
  const planned = { ...INITIAL_STATE, key: { ...INITIAL_STATE.key, planVersion: 1 } };
  const atExecute = { ...planned, stage: "execute" as const };

  it("says what going back to Sources invalidates", () => {
    const transition = goTo(atExecute, "sources");

    expect(transition.state.stage).toBe("sources");
    expect(transition.invalidated.join(" ")).toMatch(/makes the current review stale/i);
    expect(transition.invalidated).toHaveLength(1);
  });

  it("says that going back to Configure also makes the review stale", () => {
    const transition = goTo({ ...planned, stage: "review" as const }, "configure");

    expect(transition.invalidated.join(" ")).toMatch(/changing settings/i);
  });

  it("reports the same loss for Recipe as for Configure", () => {
    const fromReview = { ...planned, stage: "review" as const };

    expect(goTo(fromReview, "recipe").invalidated).toEqual(
      goTo(fromReview, "configure").invalidated,
    );
  });

  it("counts Recipe as forward from Sources and backward from Configure", () => {
    expect(goTo({ ...planned, stage: "sources" as const }, "recipe").invalidated).toEqual([]);
    expect(goTo({ ...planned, stage: "configure" as const }, "recipe").invalidated).toEqual([
      "Changing settings makes the current review stale.",
    ]);
  });

  it("invalidates nothing when no plan was ever computed", () => {
    // Standing in Review is not the same as having a plan. This is what made
    // the back-navigation dialog appear with nothing to discard.
    const noPlan = { ...INITIAL_STATE, stage: "review" as const };

    expect(goTo(noPlan, "configure").invalidated).toEqual([]);
    expect(goTo(noPlan, "sources").invalidated).toEqual([]);
    expect(goTo({ ...INITIAL_STATE, stage: "execute" as const }, "sources").invalidated).toEqual(
      [],
    );
  });

  it("invalidates nothing when moving forward", () => {
    expect(goTo(INITIAL_STATE, "recipe").invalidated).toEqual([]);
    expect(goTo(INITIAL_STATE, "configure").invalidated).toEqual([]);
    expect(goTo(INITIAL_STATE, "review").invalidated).toEqual([]);
  });

  it("gives every destination one story across the complete planned route matrix", () => {
    const stages: Stage[] = ["sources", "recipe", "configure", "review", "execute"];
    const storyFor: Record<Stage, string[]> = {
      sources: ["Changing folders makes the current review stale."],
      recipe: ["Changing settings makes the current review stale."],
      configure: ["Changing settings makes the current review stale."],
      review: [],
      execute: [],
    };

    for (const from of stages) {
      for (const destination of stages) {
        const expected = stageIndex(destination) < stageIndex(from) ? storyFor[destination] : [];
        expect(
          goTo({ ...planned, stage: from }, destination).invalidated,
          `${from} → ${destination}`,
        ).toEqual(expected);
      }
    }
  });

  it("gives the complete unplanned route matrix no invented loss", () => {
    const stages: Stage[] = ["sources", "recipe", "configure", "review", "execute"];
    for (const from of stages) {
      for (const destination of stages) {
        expect(
          goTo({ ...INITIAL_STATE, stage: from }, destination).invalidated,
          `${from} → ${destination}`,
        ).toEqual([]);
      }
    }
  });

  it("lands every stage on the one view it has", () => {
    // Review used to be entered at one of four tabs. The two modes that
    // replaced them belong to the screen, not to the flow, so there is one
    // view per stage and asking for it is asking for the only answer.
    expect(goTo(INITIAL_STATE, "review", "overview").state.view).toBe("overview");
    expect(goTo(INITIAL_STATE, "sources").state.view).toBe("overview");
  });

  it("keeps a state that already holds the stage's view", () => {
    const state = { ...INITIAL_STATE, stage: "sources" as const };

    expect(selectView(state, "overview")).toEqual(state);
  });
});

describe("Review's owner boundary", () => {
  it("publishes decisions through a stable callback rather than an inline render loop", () => {
    const pages = import.meta.glob("../../pages/MainPage.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const source = Object.values(pages)[0] ?? "";

    expect(source).toContain("const publishRunDecisions = useCallback(");
    expect(source).toContain("onDecisionsChange={publishRunDecisions}");
    expect(source).not.toMatch(/onDecisionsChange=\{\s*\([^)]*\)\s*=>/);
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
    expect(transition.state.view).toBe("overview");
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
