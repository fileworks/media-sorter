import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { CATALOG_BURST_GROUPS_AVAILABLE, type GroupKind } from "@/lib/reviewWorkbench";
import type { PlanDuplicateSet } from "@/lib/reviewRows";
import { duplicateTally, type DuplicateTally } from "@/lib/reviewPlan";
import { api, type ReviewGroup } from "@/services/api";

const LIMIT = 200;

/**
 * Pages fetched per kind before the surface stops and says so.
 *
 * The list used to stop at one page and look finished, which is the defect
 * `P-10` names: a tally drawn from 200 groups while the library holds 900 tells
 * someone they have reviewed everything when they have reviewed the first fifth.
 * Following the cursor makes the tally true; a bound keeps a pathological
 * library from being loaded into a browser tab, and when the bound is what
 * stopped us, `truncated` says so rather than the list quietly ending.
 */
const MAX_PAGES = 25;

/**
 * Every stack the catalog found, and the tally drawn from them.
 *
 * One hook rather than a query in each component so the summary tile, the chip
 * count and the item list cannot report different numbers for the same thing —
 * which they did, because the tile counted what the dry run would skip and the
 * list counted what the catalog holds. TanStack dedupes the query keys, so
 * sharing this costs no extra requests.
 *
 * Bursts are the third kind, fetched on the same terms as the other two — but
 * only while the catalog can actually produce them. Today it cannot: nothing
 * in production writes the signatures and media facts `burst_groups` reads, so
 * the request is a scan for a result that is empty by construction. The user's
 * `burst_detection_enabled` is still read and still passed in; it is simply not
 * sufficient on its own. See `CATALOG_BURST_GROUPS_AVAILABLE`.
 */
/**
 * Every page of one kind, followed to the end or to `MAX_PAGES`.
 *
 * The cursor is opaque and the server refuses one that belongs to a different
 * list or a re-indexed catalog, so a stale marker fails loudly instead of
 * paging something else.
 */
async function fetchEveryPage(
  kind: GroupKind,
): Promise<{ groups: ReviewGroup[]; truncated: boolean; partialIndex: boolean }> {
  const groups: ReviewGroup[] = [];
  let cursor: string | null = null;
  let partialIndex = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await api.listReviewGroups(kind, { limit: LIMIT, cursor });
    groups.push(...result.groups);
    // Sticky across pages: one page reporting a partial index is enough, and a
    // later page saying otherwise must not clear it.
    partialIndex = partialIndex || result.partial_index;
    cursor = result.next_cursor;
    if (!cursor) return { groups, truncated: false, partialIndex };
  }
  return { groups, truncated: true, partialIndex };
}

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
  } = {},
) {
  const kinds: GroupKind[] =
    options.bursts && CATALOG_BURST_GROUPS_AVAILABLE
      ? ["exact", "similar", "burst"]
      : ["exact", "similar"];

  // `combine` rather than reading the result array directly: the array itself
  // is new on every render, so it can never be a stable `useMemo` dependency.
  const { groups, truncated, partialIndex, isLoading, isError, error, refetch } = useQueries({
    queries: kinds.map((kind) => ({
      // Review needs the full library relationship for its honest
      // outside-this-run disclosure. Actionable rows are scoped separately to
      // `result.items`, so an excluded member still cannot become a decision.
      queryKey: ["review", "groups", kind],
      queryFn: () => fetchEveryPage(kind),
    })),
    combine: (results) => ({
      groups: results.flatMap((result) => result.data?.groups ?? []),
      truncated: results.some((result) => result.data?.truncated ?? false),
      partialIndex: results.some((result) => result.data?.partialIndex ?? false),
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
    );
  }, [decidedSetIds, groups, inScope, isLoading, planSets]);

  return {
    groups,
    /** The list is not the whole library, so nothing derived from it is either. */
    truncated,
    /** A scan skipped files, so a set here may be missing members. */
    partialIndex,
    tally,
    isLoading,
    isError,
    error,
    isEmpty: !isLoading && !isError && groups.length === 0 && (planSets?.length ?? 0) === 0,
    refetch,
  };
}
