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
  reviewStateIsDurable,
  selectView,
  stageComplete,
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
  reviewStateDurable: true,
  executionActive: false,
  blocked: false,
  blockedReason: null,
};

function issue(field: string | null, key: string): ConfigIssue {
  return { field, message: key, message_key: key, params: {} };
}

describe("a save in flight is not a change in what the review says", () => {
  // Every durable change writes to the backend, and "which duplicate set is
  // open" is durable — so stepping to the next set started a save. Folding that
  // into completeness made the stepper's Review step flick from "complete" back
  // to "Approve the plan" on every arrow press, and made the review surface
  // insert a "Saving…" row that appeared and vanished inside a frame or two,
  // taking a scrollbar with it.

  it("keeps Review complete while its decisions are being written", () => {
    const saving: StageInputs = { ...READY, reviewStateDurable: false };

    expect(stageComplete("review", READY)).toBe(true);
    expect(stageComplete("review", saving)).toBe(true);
  });

  it("still refuses Execute until those decisions are on disk", () => {
    const saving: StageInputs = { ...READY, reviewStateDurable: false };

    expect(readiness("execute", READY).canEnter).toBe(true);
    expect(readiness("execute", saving).canEnter).toBe(false);
  });

  it("leaves an undecided set incomplete however the save is going", () => {
    const undecided: StageInputs = { ...READY, duplicateReviewReady: false };

    expect(stageComplete("review", undecided)).toBe(false);
    expect(stageComplete("review", { ...undecided, reviewStateDurable: false })).toBe(false);
  });

  it("treats a save nobody could have noticed as durable, and a slow one as not", () => {
    // The fast case is the one that used to flicker: a local write finishes in
    // a few milliseconds, and reporting it changes nothing for the reader
    // except the layout under their cursor.
    expect(reviewStateIsDurable("saving", "saving", false)).toBe(true);
    expect(reviewStateIsDurable("saved", "saved", false)).toBe(true);
    expect(reviewStateIsDurable("saving", "saving", true)).toBe(false);
  });

  it("never calls a failed or unstarted save durable, however fast it was", () => {
    expect(reviewStateIsDurable("error", "saved", false)).toBe(false);
    expect(reviewStateIsDurable("saved", "error", false)).toBe(false);
    // Nothing has been written for this plan yet.
    expect(reviewStateIsDurable("idle", "saved", false)).toBe(false);
  });
});

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

  it("reattaches an active execution even when the reloaded UI has no in-memory plan", () => {
    expect(readiness("execute", { ...READY, planned: false, executionActive: true }).canEnter).toBe(
      true,
    );
  });

  it("lets Review inspect proposals but blocks Execute until every set is decided", () => {
    const awaitingDuplicates = {
      ...READY,
      duplicateReviewReady: false,
      duplicateReviewReason: "3 duplicate sets still need a decision.",
      reviewStateDurable: true,
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

describe("stage completion", () => {
  it("keeps valid completion visible when navigating backward", () => {
    expect(stageComplete("sources", READY)).toBe(true);
    expect(stageComplete("recipe", READY)).toBe(true);
    expect(stageComplete("configure", READY)).toBe(true);
    expect(stageComplete("review", READY)).toBe(true);
    expect(stageComplete("execute", READY, true)).toBe(true);
  });

  it("removes only completion whose artifact was invalidated", () => {
    const previewInvalidated = { ...READY, planned: false, duplicateReviewReady: false };
    expect(stageComplete("sources", previewInvalidated)).toBe(true);
    expect(stageComplete("recipe", previewInvalidated)).toBe(true);
    expect(stageComplete("configure", previewInvalidated)).toBe(false);
    expect(stageComplete("review", previewInvalidated)).toBe(false);
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

  /**
   * Which of Plan and Review is being read is a navigation decision, and only
   * something that navigates may make it.
   *
   * A plan arriving is not a navigation. The effect that watches the preview
   * result used to force the view back to Review whenever it changed, which
   * included the moment "Recalculate" cleared it — so a request for a fresh
   * plan, made from Plan, moved the user off Plan.
   */
  it("never rewrites the review stop from the plan-result effect", () => {
    const pages = import.meta.glob("../../pages/MainPage.tsx", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const source = Object.values(pages)[0] ?? "";

    const effect = source.slice(
      source.indexOf("useEffect(() => {\n    setAcknowledgedImpact(null);"),
    );
    const body = effect.slice(0, effect.indexOf("}, [preview.recovered, preview.result]);"));

    expect(body, "the effect was renamed or removed").not.toBe("");
    // The recovered plan restores the stop it was left at. Nothing else in
    // here may set one.
    expect(body).toContain("recoveredReviewStop(preview.result.plan_id)");
    expect(body).not.toContain('setReviewView("review")');
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

  it("does not pull a user forward after they navigated back before invalidation", () => {
    const atSources = { ...INITIAL_STATE, stage: "sources" as const, key };
    const transition = reconcile(atSources, {
      ...key,
      catalogGeneration: 0,
      planVersion: 0,
    });

    expect(transition.state.stage).toBe("sources");
  });

  it("keeps Review stable while its first scan completes", () => {
    const fresh = { profileId: "p1", catalogGeneration: 0, planVersion: 0, taskId: null };
    const atReview = { ...INITIAL_STATE, stage: "review" as const, key: fresh };

    expect(reconcile(atReview, { ...fresh, catalogGeneration: 1 }).state.stage).toBe("review");
  });

  it("notices a different profile", () => {
    const state = { ...INITIAL_STATE, key };

    expect(reconcile(state, { ...key, profileId: "p2" }).invalidated[0]).toMatch(/profile/i);
  });

  /**
   * Recalculating from the Plan view.
   *
   * Pressing "Recalculate" clears the plan, then computes a new one — two key
   * changes in quick succession, both arriving underneath a screen the user is
   * standing on and did not ask to leave. Reconciliation used to answer the
   * first by evicting them to Configure, which is the settings screen, and the
   * second by putting them back: a round trip through a stage nobody asked for.
   */
  describe("a plan being recomputed under Review", () => {
    it("keeps the user on Review while the plan is gone", () => {
      const atReview = { ...INITIAL_STATE, stage: "review" as const, key };

      expect(reconcile(atReview, { ...key, planVersion: 0 }).state.stage).toBe("review");
    });

    it("keeps them there when the new plan lands", () => {
      const cleared = { profileId: "p1", catalogGeneration: 3, planVersion: 0, taskId: null };
      const atReview = { ...INITIAL_STATE, stage: "review" as const, key: cleared };

      expect(reconcile(atReview, { ...cleared, planVersion: 5 }).state.stage).toBe("review");
    });

    it("says nothing about a plan that is gone rather than replaced", () => {
      const atReview = { ...INITIAL_STATE, stage: "review" as const, key };

      expect(reconcile(atReview, { ...key, planVersion: 0 }).invalidated).toEqual([]);
    });

    it("still reports a plan that was genuinely replaced", () => {
      const atExecute = { ...INITIAL_STATE, stage: "execute" as const, key };

      expect(reconcile(atExecute, { ...key, planVersion: 9 }).invalidated).toEqual([
        "The review plan changed.",
      ]);
    });

    it("still lands elsewhere on Configure when its plan disappears", () => {
      const atExecute = { ...INITIAL_STATE, stage: "execute" as const, key };

      expect(reconcile(atExecute, { ...key, planVersion: 0 }).state.stage).toBe("configure");
    });
  });
});
