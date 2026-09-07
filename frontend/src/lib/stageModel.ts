/** Four workflow steps; recipe selection and optional adjustments share Setup. */

export type Stage = "sources" | "configure" | "review" | "execute";

/**
 * A stage's sub-view. Every stage now has exactly one.
 *
 * Review used to be entered *at* one of four tabs, and the summary tiles
 * navigated by naming one. The rework replaced the tabs with two modes held by
 * the screen itself — Browse and Resolve are renderings of one set of rows, not
 * places the flow can land — so the four entry points describe a surface that
 * no longer exists. The concept is kept because a stage that grows sub-views
 * again should not have to reinvent it.
 */
export type View = "overview";

export const VIEWS_BY_STAGE: Record<Stage, View[]> = {
  sources: ["overview"],
  configure: ["overview"],
  review: ["overview"],
  execute: ["overview"],
};

/** What a stage's work is keyed to. When any of these change, it is stale. */
export interface StageKey {
  profileId: string;
  catalogGeneration: number;
  planVersion: number;
  taskId: string | null;
}

export interface StageState {
  stage: Stage;
  view: View;
  key: StageKey;
}

export interface StageReadiness {
  canEnter: boolean;
  reason: string | null;
}

export interface StageInputs {
  /** At least one input root and one destination, all reachable. */
  rootsReady: boolean;
  rootsReason: string | null;
  /** A catalog generation has completed for every input root. */
  scanned: boolean;
  /** A dry run exists: every proposed change has been calculated. */
  planned: boolean;
  plannedReason: string | null;
  /** Review has no proposed or undecided duplicate sets left. */
  duplicateReviewReady: boolean;
  duplicateReviewReason: string | null;
  /**
   * Review's decisions have been written to the backend.
   *
   * Deliberately separate from `duplicateReviewReady`, which is about the
   * decisions themselves. Folding the two together made "is the review
   * finished?" depend on whether a background save happened to be in flight,
   * and the surface saves on *every* durable change — including which set the
   * queue is on. Stepping to the next duplicate group therefore un-finished the
   * stage and re-finished it a few milliseconds later, which the stepper showed
   * as its Review step flicking from "complete" back to "Approve the plan".
   *
   * Entering Execute still requires it. Being finished and being saved are two
   * different claims, and only one of them is about what the reader just did.
   */
  reviewStateDurable: boolean;
  /** A backend execution survived this UI instance and is being reattached. */
  executionActive: boolean;
  /** Startup recovery or drift is holding new work. */
  blocked: boolean;
  blockedReason: string | null;
}

/**
 * Whether Review's decisions are on disk — as a gate can usefully ask it.
 *
 * The raw answer changes several times a second while somebody works: the
 * review surface writes on every durable change, and "which duplicate set is
 * open" is durable. A gate reading it directly opens and closes as fast as the
 * reader can press the next-set arrow, which is what made the stepper's Review
 * step flick between "complete" and "Approve the plan".
 *
 * `slowSave` is that same signal held back until a save is genuinely taking
 * time (see `useDelayedFlag`), so only a save worth waiting for reaches the
 * screen. This smooths what is *shown*; starting a run still checks the
 * unsmoothed state before it does anything.
 */
export function reviewStateIsDurable(
  planState: "idle" | "saving" | "saved" | "error",
  decisionState: "saving" | "saved" | "error",
  slowSave: boolean,
): boolean {
  if (planState === "error" || decisionState === "error" || planState === "idle") return false;
  return !slowSave;
}

/** Completion is based on a still-valid artifact, not screen position. */
export function stageComplete(
  stage: Stage,
  inputs: StageInputs,
  executionComplete = false,
): boolean {
  if (stage === "sources") return inputs.rootsReady;
  if (stage === "configure") return inputs.planned;
  // Decisions only. A save in flight is not an unfinished review — see
  // `reviewStateDurable`.
  if (stage === "review") return inputs.planned && inputs.duplicateReviewReady;
  return executionComplete;
}

/**
 * Whether a stage may be entered, and if not, the one sentence that says why.
 *
 * The order matters: a hard block is reported before a missing prerequisite,
 * because "finish reviewing the interrupted run" is more actionable than "pick a
 * destination folder" when both are true.
 *
 * Review is where a plan is computed as well as read, so usable roots are its
 * entry condition. Execute needs a finished plan and every duplicate proposal
 * to have become an explicit decision: proposals describe intent but
 * deliberately do not bind a run.
 */
export function readiness(stage: Stage, inputs: StageInputs): StageReadiness {
  if (inputs.blocked) {
    return { canEnter: false, reason: inputs.blockedReason ?? "Earlier work needs your decision." };
  }
  if (stage === "sources") {
    return { canEnter: true, reason: null };
  }
  if (!inputs.rootsReady) {
    return {
      canEnter: false,
      reason: inputs.rootsReason ?? "Choose at least one input folder and a destination.",
    };
  }
  // Setup requires usable folders and nothing else. Its surfaces
  // ask how the run should behave, and neither needs a scan to be answerable.
  if (stage === "configure") {
    return { canEnter: true, reason: null };
  }
  if (stage === "review") {
    return { canEnter: true, reason: null };
  }
  if (stage === "execute" && inputs.executionActive) {
    return { canEnter: true, reason: null };
  }
  if (!inputs.planned) {
    return {
      canEnter: false,
      reason: inputs.plannedReason ?? "Preview the changes first — nothing has been calculated.",
    };
  }
  if (stage === "execute" && !(inputs.duplicateReviewReady && inputs.reviewStateDurable)) {
    return {
      canEnter: false,
      reason:
        inputs.duplicateReviewReason ??
        "Decide every duplicate proposal before continuing to Execute.",
    };
  }
  return { canEnter: true, reason: null };
}

/** The flow, in the order it is walked. The stepper and every index use it. */
const ORDER: Stage[] = ["sources", "configure", "review", "execute"];

export function availableStages(inputs: StageInputs): Stage[] {
  return ORDER.filter((stage) => readiness(stage, inputs).canEnter);
}

/**
 * The stages a calculated plan makes readable rather than editable.
 *
 * Every one of them feeds the plan, so editing any of them makes it wrong. The
 * old answer was a modal per patch — six edits, six identical questions, and the
 * plan destroyed on the first answer while the remaining five asked about a plan
 * that no longer existed. The lock asks once, at the moment the intent appears.
 */
const LOCKED_BY_PLAN: readonly Stage[] = ["sources", "configure"];

/** Whether standing on this stage with a plan means reading rather than editing. */
export function isStageLocked(stage: Stage, planExists: boolean): boolean {
  return planExists && LOCKED_BY_PLAN.includes(stage);
}

/**
 * The stages that draw their own read-only boundary, so the shell does not.
 *
 * `inert` is inherited and cannot be lifted from a descendant — there is no
 * `inert="false"`. A blanket one over Configure therefore took its navigation
 * rail down with the settings, and jumping to a heading to *read* a setting
 * is not editing anything. Configure puts the boundary around its settings
 * column instead, which is the part that is actually being protected.
 */
const DRAWS_OWN_LOCK: readonly Stage[] = ["configure"];

export function stageDrawsOwnLock(stage: Stage): boolean {
  return DRAWS_OWN_LOCK.includes(stage);
}

export interface Transition {
  state: StageState;
  /** What the move invalidated, in plain language. Empty when nothing did. */
  invalidated: string[];
}

export function stageIndex(stage: Stage): number {
  return ORDER.indexOf(stage);
}

/** The next stage in the flow, or null at the end. */
export function nextStage(stage: Stage): Stage | null {
  return ORDER[ORDER.indexOf(stage) + 1] ?? null;
}

/** The previous stage in the flow, or null at the start. */
export function previousStage(stage: Stage): Stage | null {
  const index = ORDER.indexOf(stage);
  return index > 0 ? ORDER[index - 1] : null;
}

/**
 * Move to a stage, reporting what going backwards throws away.
 *
 * Returning to Sources after review is legitimate — people change their minds
 * about which folders to include — but it makes the review stale, and saying so
 * before it happens is the difference between a choice and a surprise.
 */
export function goTo(current: StageState, stage: Stage, view?: View): Transition {
  const invalidated: string[] = [];
  const backwards = ORDER.indexOf(stage) < ORDER.indexOf(current.stage);
  // Standing in Review is not the same as having computed a plan. Reporting a
  // loss that cannot happen is what made the back-navigation dialog appear when
  // there was nothing to discard, and a dialog people always dismiss is one
  // they will dismiss on the day it matters.
  const planExists = current.key.planVersion > 0;

  if (backwards && current.stage !== "sources" && planExists) {
    if (stage === "sources") {
      invalidated.push("Changing folders makes the current review stale.");
    }
    // Setup changes settings, so
    // going back to it threatens the plan in exactly the same way.
    if (stage === "configure") {
      invalidated.push("Changing settings makes the current review stale.");
    }
  }

  const views = VIEWS_BY_STAGE[stage];
  const nextView = view && views.includes(view) ? view : views[0];
  return { state: { ...current, stage, view: nextView }, invalidated };
}

export function selectView(current: StageState, view: View): StageState {
  return VIEWS_BY_STAGE[current.stage].includes(view) ? { ...current, view } : current;
}

/** Whether stored stage state still describes the world it was made in. */
export function isStale(state: StageState, key: StageKey): boolean {
  return (
    state.key.profileId !== key.profileId ||
    state.key.catalogGeneration !== key.catalogGeneration ||
    state.key.planVersion !== key.planVersion
  );
}

/** Whether two keys describe the same world, field by field. */
export function sameKey(a: StageKey, b: StageKey): boolean {
  return (
    a.profileId === b.profileId &&
    a.catalogGeneration === b.catalogGeneration &&
    a.planVersion === b.planVersion &&
    a.taskId === b.taskId
  );
}

export function reconcile(state: StageState, key: StageKey): Transition {
  // Identity matters as much as the values: the shell reconciles from an effect,
  // and handing back a fresh object for an unchanged key would set state on
  // every render and spin the app in a re-render loop.
  if (sameKey(state.key, key)) {
    return { state, invalidated: [] };
  }
  // The first live key hydrates the shell; it is not a profile change. Treating
  // the empty bootstrap key as stale used to throw a fresh launch straight
  // into Review even though no scan had happened.
  if (state.key.profileId === "") {
    return { state: { ...state, key }, invalidated: [] };
  }
  if (!isStale(state, key)) {
    return { state: { ...state, key }, invalidated: [] };
  }
  const firstScanArrived =
    state.key.catalogGeneration === 0 &&
    key.catalogGeneration > 0 &&
    state.key.planVersion === key.planVersion;
  // A scan finishing underneath Review is progress, not invalidation. Keep the
  // screen stable while the preview starts instead of bouncing to Configure.
  if (firstScanArrived) {
    return { state: { ...state, key }, invalidated: [] };
  }
  const invalidated: string[] = [];
  if (state.key.profileId !== key.profileId) {
    invalidated.push("A different library profile is active.");
  }
  // Going from "no scan" to "a scan" — or from no plan to a plan — is the work
  // arriving, not the world moving underneath the user. Only a *replacement*
  // invalidates what they were looking at, so a first scan and a first plan are
  // hydration and say nothing.
  if (state.key.catalogGeneration > 0 && state.key.catalogGeneration !== key.catalogGeneration) {
    invalidated.push("The folders were scanned again since you were last here.");
  }
  // A *replacement* plan is news; a plan that is simply gone is not. Every way
  // a plan disappears is an explicit act that already said so at the time —
  // discarding it to edit settings, starting a new run, or asking for it to be
  // calculated again — so announcing it here is a second notice for a decision
  // the user has already made.
  if (
    state.key.planVersion > 0 &&
    key.planVersion > 0 &&
    state.key.planVersion !== key.planVersion
  ) {
    invalidated.push("The review plan changed.");
  }
  // A plan that no longer exists cannot be reviewed. Landing on Configure —
  // the last stage whose entry condition still holds — beats landing on an
  // empty Review and having to work out why it is empty.
  const fallback: Stage = key.planVersion > 0 ? "review" : "configure";
  // Reconciliation may move a stale downstream screen back to the last valid
  // stage, but never pulls somebody forward after deliberate back navigation.
  const firstPlanArrived = state.key.planVersion === 0 && key.planVersion > 0;
  // Review is the one stage that *computes* a plan as well as reads one, and
  // it has a state for every moment in between. Evicting it the instant its
  // plan went away sent "Recalculate" to the settings screen — the plan is
  // being rebuilt by the very screen it was thrown off.
  const landing = firstPlanArrived
    ? "review"
    : state.stage === "review"
      ? "review"
      : stageIndex(state.stage) < stageIndex(fallback)
        ? state.stage
        : fallback;
  return {
    state: {
      stage: landing,
      view: VIEWS_BY_STAGE[landing][0],
      key,
    },
    invalidated,
  };
}

export const INITIAL_STATE: StageState = {
  stage: "sources",
  view: "overview",
  key: { profileId: "", catalogGeneration: 0, planVersion: 0, taskId: null },
};

export interface StageLabel {
  stage: Stage;
  label: string;
  description: string;
}

export const STAGE_LABELS: StageLabel[] = [
  { stage: "sources", label: "Sources", description: "Which folders, and what each one is for" },
  {
    stage: "configure",
    label: "Setup",
    description: "How files travel, land, and get cleaned",
  },
  { stage: "review", label: "Review", description: "What would change, before anything does" },
  { stage: "execute", label: "Execute", description: "Perform the reviewed plan" },
];
