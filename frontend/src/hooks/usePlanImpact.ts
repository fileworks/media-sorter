import { useQuery } from "@tanstack/react-query";

import { api } from "@/services/api";
import type { PlanImpact } from "@/types/api";

/**
 * What the plan will do once Review's exclusions are applied.
 *
 * Asked rather than derived. Execute used to subtract a per-reviewed-file tally
 * from the stored plan's action-level totals; a companion is an action but not
 * a reviewed file, so excluding a RAW+JPEG pair took one file and the JPEG's
 * bytes off a total holding two files and both — the preflight then promised a
 * copy that would never happen, and checked free space against the wrong size.
 *
 * Keyed by the exclusion set, so toggling one file costs one small request and
 * repeats are served from cache.
 */
export function usePlanImpact(planId: string | undefined, excludedSources: string[]) {
  const key = [...excludedSources].sort();
  return useQuery<PlanImpact>({
    queryKey: ["sorting", "impact", planId, key],
    queryFn: () => api.planImpact(planId as string, key),
    enabled: planId !== undefined,
    staleTime: Infinity,
  });
}
