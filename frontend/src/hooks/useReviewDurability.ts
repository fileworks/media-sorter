import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { reviewStateIsDurable } from "@/lib/stageModel";

import type { PlanPersistenceState } from "@/hooks/usePreview";
import type { ReviewPersistenceState } from "@/hooks/useReviewSurface";

/**
 * Whether Review's decisions are on disk, as the Execute gate should read it.
 *
 * Two states in, one answer out, with the transient middle smoothed: see
 * `reviewStateIsDurable` for why a save in flight must not close a gate the
 * reader is standing at, and `useDelayedFlag` for what "in flight" has to mean
 * before it is worth showing anybody.
 *
 * This smooths what is *shown*. Starting a run reads the two states directly.
 */
export function useReviewDurability(
  planState: PlanPersistenceState,
  decisionState: ReviewPersistenceState,
): boolean {
  const slowSave = useDelayedFlag(planState === "saving" || decisionState === "saving");
  return reviewStateIsDurable(planState, decisionState, slowSave);
}
