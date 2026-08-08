import { useQuery } from "@tanstack/react-query";

import { api, type ReviewedSet } from "@/services/api";
import type { PlanImpact } from "@/types/api";

/**
 * What the scoped plan will do once Review's duplicate decisions are applied.
 */
export function usePlanImpact(
  planId: string | undefined,
  excludedRoots: string[],
  reviewedSets: ReviewedSet[] = [],
) {
  const key = [...excludedRoots].sort();
  // Keyed by the decisions too: promoting a copy changes what the run does, so
  // a cached impact from before the decision would describe a different run.
  const sets = [...reviewedSets].sort((a, b) => a.keep.localeCompare(b.keep));
  return useQuery<PlanImpact>({
    queryKey: ["sorting", "impact", planId, key, sets.map((set) => set.keep)],
    queryFn: () => api.planImpact(planId as string, key, sets),
    enabled: planId !== undefined,
    staleTime: Infinity,
  });
}
