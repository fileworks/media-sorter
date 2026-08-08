/**
 * Five stages, several views, and one rule about going backwards.
 *
 * Sources → Recipe → Configure → Review → Execute. Each stage has an entry
 * condition, and moving back to an earlier one invalidates what depended on it —
 * which is the whole reason the model is typed rather than a string in a
 * component: "can I press Execute?" must have exactly one answer, and it must be
 * the same answer everywhere.
 *
 * Configure is its own stage rather than a panel inside Sources because the two
 * ask different questions. Sources asks *where*, and its answer decides whether
 * anything can run at all; Configure asks *how*, and every one of its answers
 * already has a safe default. Splitting them is what lets Sources stay a screen
 * somebody can finish in fifteen seconds.
 *
 * Recipe is its own stage for the mirror-image reason. Picking one writes
 * fifteen settings in a single click — the largest decision in the flow — and it
 * used to be the first card *inside* Configure, visually a peer of the smallest
 * decisions and below the screen's own heading. A stage names it in the stepper,
 * lets Configure say which recipe it is fine-tuning, and makes it revisitable
 * without hunting. It shares Configure's entry condition: both are about *how*,
 * and neither can be answered before there are folders.
 */

export type Stage = "sources" | "recipe" | "configure" | "review" | "execute";

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
  recipe: ["overview"],
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
  /** Startup recovery or drift is holding new work. */
  blocked: boolean;
  blockedReason: string | null;
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
  // Recipe and Configure share the gate: usable folders and nothing else. Both
  // ask how the run should behave, and neither needs a scan to be answerable.
  if (stage === "recipe" || stage === "configure") {
    return { canEnter: true, reason: null };
  }
  if (stage === "review") {
    return { canEnter: true, reason: null };
  }
  if (!inputs.planned) {
    return {
      canEnter: false,
      reason: inputs.plannedReason ?? "Preview the changes first — nothing has been calculated.",
    };
  }
  if (stage === "execute" && !inputs.duplicateReviewReady) {
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
const ORDER: Stage[] = ["sources", "recipe", "configure", "review", "execute"];

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
const LOCKED_BY_PLAN: readonly Stage[] = ["sources", "recipe", "configure"];

/** Whether standing on this stage with a plan means reading rather than editing. */
export function isStageLocked(stage: Stage, planExists: boolean): boolean {
  return planExists && LOCKED_BY_PLAN.includes(stage);
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
    // Recipe reports what Configure reports: a recipe writes settings, so
    // going back to it threatens the plan in exactly the same way.
    if (stage === "recipe" || stage === "configure") {
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
  if (state.key.planVersion > 0 && state.key.planVersion !== key.planVersion) {
    invalidated.push("The review plan changed.");
  }
  // A plan that no longer exists cannot be reviewed. Landing on Configure —
  // the last stage whose entry condition still holds — beats landing on an
  // empty Review and having to work out why it is empty.
  const landing: Stage = key.planVersion > 0 ? "review" : "configure";
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
    stage: "recipe",
    label: "Recipe",
    description: "The starting point everything else adjusts",
  },
  {
    stage: "configure",
    label: "Configure",
    description: "How files travel, land, and get cleaned",
  },
  { stage: "review", label: "Review", description: "What would change, before anything does" },
  { stage: "execute", label: "Execute", description: "Perform the reviewed plan" },
];
