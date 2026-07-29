/**
 * Three stages, several views, and one rule about going backwards.
 *
 * Sources → Review → Execute. Each stage has an entry condition, and moving back
 * to an earlier one invalidates what depended on it — which is the whole reason
 * the model is typed rather than a string in a component: "can I press Execute?"
 * must have exactly one answer, and it must be the same answer everywhere.
 */

export type Stage = "sources" | "review" | "execute";

export type View =
  | "overview"
  | "organization"
  | "exact"
  | "similar"
  | "bursts"
  | "reconciliation"
  | "validation"
  | "issues";

export const VIEWS_BY_STAGE: Record<Stage, View[]> = {
  sources: ["overview"],
  review: [
    "overview",
    "organization",
    "exact",
    "similar",
    "bursts",
    "reconciliation",
    "validation",
    "issues",
  ],
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
  /** At least one group has been reviewed, or there was nothing to review. */
  reviewed: boolean;
  reviewedReason: string | null;
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
  if (stage === "review") {
    return inputs.scanned
      ? { canEnter: true, reason: null }
      : { canEnter: false, reason: "Scan the folders first — there is nothing to review yet." };
  }
  if (!inputs.scanned) {
    return { canEnter: false, reason: "Scan the folders first." };
  }
  return inputs.reviewed
    ? { canEnter: true, reason: null }
    : {
        canEnter: false,
        reason: inputs.reviewedReason ?? "Review the proposed changes before executing them.",
      };
}

export function availableStages(inputs: StageInputs): Stage[] {
  return (["sources", "review", "execute"] as Stage[]).filter(
    (stage) => readiness(stage, inputs).canEnter,
  );
}

export interface Transition {
  state: StageState;
  /** What the move invalidated, in plain language. Empty when nothing did. */
  invalidated: string[];
}

const ORDER: Stage[] = ["sources", "review", "execute"];

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

  if (backwards && current.stage !== "sources") {
    if (stage === "sources") {
      invalidated.push("Changing folders makes the current review stale.");
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

export function reconcile(state: StageState, key: StageKey): Transition {
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
  if (state.key.catalogGeneration !== key.catalogGeneration) {
    invalidated.push("The folders were scanned again since you were last here.");
  }
  if (state.key.planVersion !== key.planVersion) {
    invalidated.push("The review plan changed.");
  }
  return {
    state: { stage: "review", view: "overview", key },
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
  { stage: "review", label: "Review", description: "What would change, before anything does" },
  { stage: "execute", label: "Execute", description: "Perform the reviewed plan" },
];
