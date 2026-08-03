import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { groupRow, type DuplicateGroup, type GroupPlan } from "@/lib/reviewWorkbench";
import type { DuplicateTally } from "@/lib/reviewPlan";
import { api } from "@/services/api";

const LIMIT = 200;

/**
 * The duplicate groups the catalog found, and the tally drawn from them.
 *
 * One hook rather than a query in each component so the summary tile, the tab
 * badge and the workbench cannot report different numbers for the same thing —
 * which they did, because the tile counted what the dry run would skip and the
 * workbench counted what the catalog holds. TanStack dedupes the two query
 * keys, so sharing this costs no extra requests.
 */
export function useReviewGroups(plans: Record<string, GroupPlan> = {}) {
  const exact = useQuery({
    queryKey: ["review", "groups", "exact"],
    queryFn: () => api.listReviewGroups("exact", { limit: LIMIT }),
  });
  const similar = useQuery({
    queryKey: ["review", "groups", "similar"],
    queryFn: () => api.listReviewGroups("similar", { limit: LIMIT }),
  });

  const groups = useMemo(
    () => [...(exact.data?.groups ?? []), ...(similar.data?.groups ?? [])] as DuplicateGroup[],
    [exact.data, similar.data],
  );

  const tally = useMemo<DuplicateTally | null>(() => {
    if (exact.isLoading || similar.isLoading) return null;
    const rows = groups.map((group) => groupRow(group, plans[group.group_id]));
    return {
      files: groups.reduce((total, group) => total + group.member_count, 0),
      resolved: rows.filter((row) => row.state === "reviewed").length,
      unresolved: rows.filter((row) => row.state === "unresolved").length,
    };
  }, [exact.isLoading, groups, plans, similar.isLoading]);

  return {
    groups,
    tally,
    isLoading: exact.isLoading || similar.isLoading,
    isError: exact.isError || similar.isError,
    refetch: () => {
      void exact.refetch();
      void similar.refetch();
    },
  };
}
