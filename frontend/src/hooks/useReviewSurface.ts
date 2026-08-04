import { useCallback, useEffect, useMemo, useState } from "react";

import type { ViewMode } from "@/components/screens/review/ReviewToolbar";
import {
  applyFilters,
  expandExclusion,
  reconcileExclusions,
  rowCounts,
  seedExclusions,
  toReviewRows,
  treeFromRows,
  type FilterKey,
} from "@/lib/reviewRows";
import type { DuplicateGroup, GroupPlan } from "@/lib/reviewWorkbench";
import type { KeeperPolicyId } from "@/services/api";
import type { PreviewResult } from "@/types/api";

const VIEW_KEY = "mediasort_review_view";
const FILTER_KEY = "mediasort_review_filter";

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * The Review screen's run state: what is excluded, what keeper was overridden,
 * what is selected and what is being looked at.
 *
 * Exclusions and keeper overrides are **run state, not configuration** — they
 * are sent to `sorting/start` and forgotten, so the next run begins from the
 * recipe rather than from what somebody did once. The view and filter are
 * preferences and do persist.
 */
export function useReviewSurface(
  result: PreviewResult,
  stacks: DuplicateGroup[],
  plans: Record<string, GroupPlan | undefined>,
  defaultKeepPolicy: KeeperPolicyId,
) {
  const [excluded, setExcluded] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastToggled, setLastToggled] = useState<string | null>(null);
  const [filter, setFilterState] = useState<FilterKey>(() =>
    stored<FilterKey>(FILTER_KEY, "all", [
      "all",
      "organize",
      "duplicates",
      "junk",
      "already_there",
      "unreadable",
      "no_date",
      "suspicious_date",
      "future_date",
      "excluded",
    ]),
  );
  const [search, setSearch] = useState("");
  const [treePath, setTreePath] = useState<string | null>(null);
  const [view, setViewState] = useState<ViewMode>(() =>
    stored<ViewMode>(VIEW_KEY, "list", ["list", "grid"]),
  );
  const [keepPolicy, setKeepPolicy] = useState<KeeperPolicyId>(defaultKeepPolicy);
  const [droppedExclusions, setDroppedExclusions] = useState(0);

  const setView = useCallback((next: ViewMode) => {
    setViewState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, next);
  }, []);

  const setFilter = useCallback((next: FilterKey) => {
    setFilterState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(FILTER_KEY, next);
  }, []);

  // Rows without exclusions applied, so the seed and the reconciliation have
  // something stable to compute against.
  const baseRows = useMemo(
    () => toReviewRows(result, stacks, plans, new Set()),
    [plans, result, stacks],
  );

  // A new plan seeds its exclusions; an existing set survives a re-preview,
  // keyed by source path, with vanished paths dropped and reported once.
  //
  // The reconciliation is computed in the effect body rather than inside the
  // updater: an updater must be pure, and React may run it more than once for
  // one commit — which would report the same dropped exclusions twice.
  useEffect(() => {
    setExcluded((current) => (current === null ? seedExclusions(baseRows) : current));
  }, [baseRows]);

  // Runs again whenever the set changes, which costs one pass over the rows per
  // exclude/include; every source just added is present by construction, so it
  // finds nothing to drop and settles immediately.
  useEffect(() => {
    if (excluded === null) return;
    const { kept, dropped } = reconcileExclusions(baseRows, excluded);
    if (dropped === 0) return;
    setExcluded(kept);
    setDroppedExclusions(dropped);
  }, [baseRows, excluded]);

  // Memoised: a fresh Set on every render would make every derived value below
  // recompute on every render, over a list that can hold tens of thousands.
  const effectiveExcluded = useMemo(() => excluded ?? new Set<string>(), [excluded]);

  const rows = useMemo(
    () => toReviewRows(result, stacks, plans, effectiveExcluded),
    [effectiveExcluded, plans, result, stacks],
  );

  const counts = useMemo(() => rowCounts(rows), [rows]);
  const tree = useMemo(() => treeFromRows(rows), [rows]);
  const visible = useMemo(
    () => applyFilters(rows, { filter, search, treePath }),
    [filter, rows, search, treePath],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.source)),
    [rows, selected],
  );

  const toggle = useCallback(
    (source: string, shiftKey: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        if (shiftKey && lastToggled !== null) {
          // Shift extends over what is visible, not over the whole plan — a
          // range you cannot see is a range you did not mean.
          const from = visible.findIndex((row) => row.source === lastToggled);
          const to = visible.findIndex((row) => row.source === source);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (let index = start; index <= end; index += 1) next.add(visible[index].source);
            return next;
          }
        }
        if (next.has(source)) next.delete(source);
        else next.add(source);
        return next;
      });
      setLastToggled(source);
    },
    [lastToggled, visible],
  );

  const selectAllVisible = useCallback(() => {
    setSelected(
      new Set(visible.filter((row) => row.status !== "baseline").map((row) => row.source)),
    );
  }, [visible]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const exclude = useCallback(
    (sources: string[]) => {
      setExcluded((current) => {
        const next = new Set(current ?? []);
        for (const source of expandExclusion(baseRows, sources)) next.add(source);
        return next;
      });
    },
    [baseRows],
  );

  const include = useCallback(
    (sources: string[]) => {
      setExcluded((current) => {
        const next = new Set(current ?? []);
        for (const source of expandExclusion(baseRows, sources)) next.delete(source);
        return next;
      });
    },
    [baseRows],
  );

  return {
    rows,
    visible,
    counts,
    tree,
    excluded: effectiveExcluded,
    droppedExclusions,
    acknowledgeDropped: () => setDroppedExclusions(0),
    selected,
    selectedRows,
    toggle,
    selectAllVisible,
    clearSelection,
    exclude,
    include,
    filter,
    setFilter,
    search,
    setSearch,
    treePath,
    setTreePath,
    view,
    setView,
    keepPolicy,
    setKeepPolicy,
  };
}
