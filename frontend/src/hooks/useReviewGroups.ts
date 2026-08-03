import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import {
  groupRow,
  type DuplicateGroup,
  type GroupKind,
  type GroupPlan,
} from "@/lib/reviewWorkbench";
import type { DuplicateTally } from "@/lib/reviewPlan";
import { api } from "@/services/api";

const LIMIT = 200;

/**
 * Every stack the catalog found, and the tally drawn from them.
 *
 * One hook rather than a query in each component so the summary tile, the chip
 * count and the item list cannot report different numbers for the same thing —
 * which they did, because the tile counted what the dry run would skip and the
 * list counted what the catalog holds. TanStack dedupes the query keys, so
 * sharing this costs no extra requests.
 *
 * Bursts are the third kind, fetched on the same terms as the other two and
 * only when burst detection is switched on: asking for them otherwise would
 * make the catalog scan for a result that is empty by construction.
 */
export function useReviewGroups(
  plans: Record<string, GroupPlan | undefined> = {},
  options: { bursts?: boolean } = {},
) {
  const kinds: GroupKind[] = options.bursts ? ["exact", "similar", "burst"] : ["exact", "similar"];

  // `combine` rather than reading the result array directly: the array itself
  // is new on every render, so it can never be a stable `useMemo` dependency.
  const { groups, isLoading, isError, refetch } = useQueries({
    queries: kinds.map((kind) => ({
      queryKey: ["review", "groups", kind],
      queryFn: () => api.listReviewGroups(kind, { limit: LIMIT }),
    })),
    combine: (results) => ({
      groups: results.flatMap((result) => result.data?.groups ?? []) as DuplicateGroup[],
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
      refetch: () => {
        for (const result of results) void result.refetch();
      },
    }),
  });

  const tally = useMemo<DuplicateTally | null>(() => {
    if (isLoading) return null;
    const rows = groups.map((group) => groupRow(group, plans[group.group_id]));
    return {
      files: groups.reduce((total, group) => total + group.member_count, 0),
      resolved: rows.filter((row) => row.state === "reviewed").length,
      unresolved: rows.filter((row) => row.state === "unresolved").length,
    };
  }, [groups, isLoading, plans]);

  return { groups, tally, isLoading, isError, refetch };
}
