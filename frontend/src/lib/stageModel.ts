/**
 * Four stages, several views, and one rule about going backwards.
 *
 * Sources → Configure → Review → Execute. Each stage has an entry condition, and
 * moving back to an earlier one invalidates what depended on it — which is the
 * whole reason the model is typed rather than a string in a component: "can I
 * press Execute?" must have exactly one answer, and it must be the same answer
 * everywhere.
 *
 * Configure is its own stage rather than a panel inside Sources because the two
 * ask different questions. Sources asks *where*, and its answer decides whether
 * anything can run at all; Configure asks *how*, and every one of its answers
 * already has a safe default. Splitting them is what lets Sources stay a screen
 * somebody can finish in fifteen seconds.
 */

export type Stage = "sources" | "configure" | "review" | "execute";

/**
 * Views only exist inside Review. The first four are the design's tabs; the
 * rest are the specialist workbenches this app has that the tab bar reveals
 * only when the run actually contains that kind of work.
 */
export type View =
  | "overview"
  | "duplicates"
  | "junk"
  | "changes"
  | "warnings"
  | "bursts"
  | "reconciliation"
  | "library";

/** The four tabs the Review screen always shows, in order. */
export const PRIMARY_REVIEW_VIEWS: View[] = ["duplicates", "junk", "changes", "warnings"];

/** Shown as extra tabs, and only when the run has something to put in them. */
export const ADVANCED_REVIEW_VIEWS: View[] = ["bursts", "reconciliation", "library"];

export const VIEWS_BY_STAGE: Record<Stage, View[]> = {
  sources: ["overview"],
  configure: ["overview"],
  review: [...PRIMARY_REVIEW_VIEWS, ...ADVANCED_REVIEW_VIEWS],
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
 * Review and Execute share the same gate — a calculated plan — because in this
 * flow Review *is* the plan. There is nothing to review before one exists, and
 * nothing to execute either.
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
  if (stage === "configure") {
    return { canEnter: true, reason: null };
  }
  return inputs.planned
    ? { canEnter: true, reason: null }
    : {
        canEnter: false,
        reason: inputs.plannedReason ?? "Preview the changes first — nothing has been calculated.",
      };
}

export function availableStages(inputs: StageInputs): Stage[] {
  return (["sources", "configure", "review", "execute"] as Stage[]).filter(
    (stage) => readiness(stage, inputs).canEnter,
  );
}

export interface Transition {
  state: StageState;
  /** What the move invalidated, in plain language. Empty when nothing did. */
  invalidated: string[];
}

const ORDER: Stage[] = ["sources", "configure", "review", "execute"];

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
  const reviewExists = ORDER.indexOf(current.stage) >= ORDER.indexOf("review");

  if (backwards && current.stage !== "sources") {
    if (stage === "sources" && reviewExists) {
      invalidated.push("Changing folders makes the current review stale.");
    }
    if (stage === "configure" && reviewExists) {
      invalidated.push("Changing settings makes the current review stale.");
    }
    if (current.stage === "execute") {
      invalidated.push("The frozen plan for this run is discarded; a new one will be taken.");
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
  { stage: "configure", label: "Configure", description: "How files travel, land, and get cleaned" },
  { stage: "review", label: "Review", description: "What would change, before anything does" },
  { stage: "execute", label: "Execute", description: "Perform the reviewed plan" },
];
