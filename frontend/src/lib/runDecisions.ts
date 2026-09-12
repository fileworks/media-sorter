import type { PlanReviewState, ReviewedSet } from "@/services/api";

export interface RunDecisions {
  planId: string | null;
  reviewedSets: ReviewedSet[];
  outstandingSets: number | null;
  proposedSets: number;
  undecidedSets: number;
  persistenceState: "saving" | "saved" | "error";
  persistenceError: string | null;
  reviewState?: PlanReviewState;
}

export type ReviewDecisionUpdate = Omit<RunDecisions, "planId">;

export function sameReviewedSets(left: ReviewedSet[], right: ReviewedSet[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every(
    (set, index) =>
      set.keep === right[index]?.keep &&
      set.keep_all === right[index]?.keep_all &&
      set.demote.length === right[index]?.demote.length &&
      set.demote.every((path, pathIndex) => path === right[index]?.demote[pathIndex]),
  );
}

export const EMPTY_RUN_DECISIONS: RunDecisions = {
  planId: null,
  reviewedSets: [],
  outstandingSets: null,
  proposedSets: 0,
  undecidedSets: 0,
  persistenceState: "saving",
  persistenceError: null,
};
