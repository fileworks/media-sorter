import { useQuery } from "@tanstack/react-query";

import { api, type ReviewedSet } from "@/services/api";
import type { PlanImpact } from "@/types/api";

/** Canonical identity of the exact impact the user is reviewing. */
export function planImpactFingerprint(
  excludedRoots: readonly string[],
  reviewedSets: readonly ReviewedSet[],
): string {
  const roots = [...excludedRoots].sort();
  const sets = reviewedSets
    .map((set) => ({
      keep: set.keep,
      demote: [...set.demote].sort(),
      keep_all: set.keep_all === true,
    }))
    .sort((left, right) =>
      `${left.keep}\u0000${left.demote.join("\u0000")}\u0000${left.keep_all}`.localeCompare(
        `${right.keep}\u0000${right.demote.join("\u0000")}\u0000${right.keep_all}`,
      ),
    );
  return JSON.stringify({ roots, sets });
}

/**
 * What the scoped plan will do once Review's duplicate decisions are applied.
 */
export function usePlanImpact(
  planId: string | undefined,
  excludedRoots: string[],
  reviewedSets: ReviewedSet[] = [],
) {
  const fingerprint = planImpactFingerprint(excludedRoots, reviewedSets);
  const canonical = JSON.parse(fingerprint) as {
    roots: string[];
    sets: Array<{ keep: string; demote: string[]; keep_all: boolean }>;
  };
  return useQuery<PlanImpact>({
    queryKey: ["sorting", "impact", planId, fingerprint],
    queryFn: () => api.planImpact(planId as string, canonical.roots, canonical.sets),
    enabled: planId !== undefined,
    staleTime: Infinity,
  });
}
