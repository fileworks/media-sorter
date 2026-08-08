import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import type { GroupKind } from "@/lib/reviewWorkbench";
import type { PlanDuplicateSet } from "@/lib/reviewRows";
import { duplicateTally, type DuplicateTally } from "@/lib/reviewPlan";
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
  /** Source paths this run acts on, so the tally can be scoped to it. */
  inScope: ReadonlySet<string> = new Set(),
  /** Sets with a binding answer on this screen, including "not duplicates". */
  decidedSetIds: ReadonlySet<string> = new Set(),
  options: {
    bursts?: boolean;
    /**
     * Sets the dry run found for itself, which the catalog may not hold.
     *
     * Appended after the catalog's, so an overlap is attributed to the catalog:
     * `duplicateTally` claims members strongest-first and skips a set with fewer
     * than two unclaimed ones, which is what counts a file in both exactly once.
     */
    planSets?: readonly PlanDuplicateSet[];
    /** Root ids sent to the catalog query, and paths used by the local tally. */
    excludedRootIds?: readonly string[];
    excludedRootPaths?: readonly string[];
  } = {},
) {
  const kinds: GroupKind[] = options.bursts ? ["exact", "similar", "burst"] : ["exact", "similar"];
  const excludedRootIds = [...(options.excludedRootIds ?? [])].sort();

  // `combine` rather than reading the result array directly: the array itself
  // is new on every render, so it can never be a stable `useMemo` dependency.
  const { groups, isLoading, isError, error, refetch } = useQueries({
    queries: kinds.map((kind) => ({
      queryKey: ["review", "groups", kind, excludedRootIds],
      queryFn: () => api.listReviewGroups(kind, { limit: LIMIT, excludedRoots: excludedRootIds }),
    })),
    combine: (results) => ({
      groups: results.flatMap((result) => result.data?.groups ?? []),
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
      error: results.find((result) => result.isError)?.error ?? null,
      refetch: () => {
        for (const result of results) void result.refetch();
      },
    }),
  });

  const planSets = options.planSets;
  const tally = useMemo<DuplicateTally | null>(() => {
    if (isLoading) return null;
    return duplicateTally(
      [
        ...groups.map((group) => ({
          id: group.group_id,
          kind: group.kind,
          memberPaths: group.members.map((member) => member.observed_path),
          // Decided means the user chose, not that a default exists. An anchor
          // the run would fall back to is not a decision anybody made.
          decided: decidedSetIds.has(group.group_id),
        })),
        ...(planSets ?? []).map((set) => ({
          id: set.id,
          kind: set.kind,
          memberPaths: set.memberPaths,
          decided: decidedSetIds.has(set.id),
        })),
      ],
      inScope,
      options.excludedRootPaths,
    );
  }, [decidedSetIds, groups, inScope, isLoading, options.excludedRootPaths, planSets]);

  return {
    groups,
    tally,
    isLoading,
    isError,
    error,
    isEmpty: !isLoading && !isError && groups.length === 0 && (planSets?.length ?? 0) === 0,
    refetch,
  };
}
