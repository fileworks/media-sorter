import { useCallback, useEffect, useMemo, useState } from "react";

import type { ViewMode } from "@/components/screens/review/ReviewToolbar";
import { keeperProposals, type DuplicateDecision } from "@/lib/duplicateDecisions";
import { planDuplicateSets, reviewedSetsFrom, toReviewRows } from "@/lib/reviewRows";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import type { KeeperPolicyId } from "@/services/api";
import type { PreviewResult } from "@/types/api";

const VIEW_KEY = "mediasort_review_view";
const MODE_KEY = "mediasort_review_mode";

/**
 * Browsing what the run would build, or deciding between copies.
 *
 * Two renderings of one set of rows and one set of decisions, never two screens:
 * switching modes keeps selection, keeper choices and the browsing
 * position, because they are all held here. The list was already good — what it
 * could not be was a queue, and "decide twelve things" has no list shape.
 */
export type ReviewMode = "browse" | "resolve";

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * The Review screen's run state: what keeper was overridden, what is selected,
 * and what is being looked at.
 *
 * Keeper overrides are run state, sent to `sorting/start` and forgotten. The
 * view and filter are preferences and do persist.
 */
export function useReviewSurface(
  result: PreviewResult,
  stacks: DuplicateGroup[],
  defaultKeepPolicy: KeeperPolicyId,
) {
  const [mode, setModeState] = useState<ReviewMode>(() =>
    stored<ReviewMode>(MODE_KEY, "browse", ["browse", "resolve"]),
  );
  /** Which set the queue is on. Null means "the first one still undecided". */
  const [queueSetId, setQueueSetId] = useState<string | null>(null);
  /** The file the detail view is open on, by source path. */
  const [detailPath, setDetailPath] = useState<string | null>(null);
  /** The file being examined full screen, which may be opened over the detail view. */
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  // Keeper choices, held here and sent with the run — never round-tripped.
  // They used to POST to `/api/review/decide`, which wrote a server-side plan
  // nothing read back: the refetch that followed returned identical data, so
  // the screen showed the same thing before and after every decision.
  const [decisions, setDecisions] = useState<Map<string, DuplicateDecision>>(new Map());
  /** Set-level selection shared by Browse and Resolve. */
  const [selectedSetIds, setSelectedSetIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastToggled, setLastToggled] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [treePath, setTreePath] = useState<string | null>(null);
  const [view, setViewState] = useState<ViewMode>(() =>
    stored<ViewMode>(VIEW_KEY, "list", ["list", "grid"]),
  );
  const [keepPolicy, setKeepPolicy] = useState<KeeperPolicyId>(defaultKeepPolicy);

  const proposals = useMemo(
    () => keeperProposals(stacks, keepPolicy, decisions),
    [decisions, keepPolicy, stacks],
  );

  /** Compatibility view for the catalog tally: binding keeper choices only. */
  const keeperOverrides = useMemo(
    () =>
      new Map(
        [...decisions]
          .filter(
            (entry): entry is [string, Extract<DuplicateDecision, { kind: "keeper" }>] =>
              entry[1].kind === "keeper",
          )
          .map(([setId, decision]) => [setId, decision.memberId]),
      ),
    [decisions],
  );

  const setView = useCallback((next: ViewMode) => {
    setViewState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, next);
  }, []);

  const setMode = useCallback((next: ReviewMode) => {
    setModeState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_KEY, next);
  }, []);

  const rows = useMemo(
    () => toReviewRows(result, stacks, decisions, proposals),
    [decisions, proposals, result, stacks],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.source)),
    [rows, selected],
  );

  /**
   * Select one file, or every file between it and the last one selected.
   *
   * The range runs over `order` — the sequence the pane is *showing* — rather
   * than over the whole plan. A range you cannot see is a range you did not
   * mean, and with the folder tree narrowing the pane, the plan's order and the
   * pane's order are rarely the same thing. The caller supplies it because the
   * caller is the only thing that knows what it drew.
   */
  const toggle = useCallback(
    (source: string, shiftKey: boolean, order: readonly string[] = []) => {
      setSelected((current) => {
        const next = new Set(current);
        if (shiftKey && lastToggled !== null) {
          const from = order.indexOf(lastToggled);
          const to = order.indexOf(source);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (let index = start; index <= end; index += 1) next.add(order[index]);
            return next;
          }
        }
        if (next.has(source)) next.delete(source);
        else next.add(source);
        return next;
      });
      setLastToggled(source);
    },
    [lastToggled],
  );

  const selectAllVisible = useCallback(
    (order: readonly string[]) => {
      const selectable = new Set(
        rows.filter((row) => row.status !== "baseline").map((row) => row.source),
      );
      setSelected(new Set(order.filter((source) => selectable.has(source))));
    },
    [rows],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  /**
   * Every set a decision can belong to, from both detections.
   *
   * Derived from the catalog groups and the plan rather than from `rows`, which
   * would depend on the overrides this guards and make the reconciliation
   * re-enter itself. Reading the catalog alone dropped every decision made on a
   * set only the dry run found, the moment it was made.
   */
  const liveSetIds = useMemo(() => {
    const ids = new Set(stacks.map((group) => group.group_id));
    for (const set of planDuplicateSets(result.items)) ids.add(set.id);
    return ids;
  }, [result.items, stacks]);

  // Reconcile against vanished groups: a re-preview that still holds the group
  // keeps the decision, and one that does not drops it rather than sending the
  // run a path it no longer has an action for.
  useEffect(() => {
    setDecisions((current) => {
      if (current.size === 0) return current;
      if ([...current.keys()].every((id) => liveSetIds.has(id))) return current;
      return new Map([...current].filter(([id]) => liveSetIds.has(id)));
    });
    setSelectedSetIds((current) => {
      if ([...current].every((id) => liveSetIds.has(id))) return current;
      return new Set([...current].filter((id) => liveSetIds.has(id)));
    });
  }, [liveSetIds]);

  const chooseKeeper = useCallback((groupId: string, memberId: string) => {
    setDecisions((current) => new Map(current).set(groupId, { kind: "keeper", memberId }));
  }, []);

  const markNotDuplicates = useCallback((groupId: string) => {
    setDecisions((current) => new Map(current).set(groupId, { kind: "keep_all" }));
  }, []);

  const clearDecision = useCallback((groupId: string) => {
    setDecisions((current) => {
      if (!current.has(groupId)) return current;
      const next = new Map(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  const acceptProposal = useCallback(
    (groupId: string) => {
      const proposal = proposals.get(groupId);
      if (proposal) chooseKeeper(groupId, proposal.memberId);
    },
    [chooseKeeper, proposals],
  );

  const acceptAllProposals = useCallback(() => {
    setDecisions((current) => {
      const next = new Map(current);
      for (const [groupId, proposal] of proposals) {
        next.set(groupId, { kind: "keeper", memberId: proposal.memberId });
      }
      return next;
    });
  }, [proposals]);

  const toggleSetSelection = useCallback((groupId: string) => {
    setSelectedSetIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const selectSets = useCallback((groupIds: readonly string[]) => {
    setSelectedSetIds(new Set(groupIds));
  }, []);

  const clearSetSelection = useCallback(() => setSelectedSetIds(new Set()), []);

  /** What the run is told, derived in a module that can be tested without a DOM. */
  const reviewedSets = useMemo(() => reviewedSetsFrom(rows, decisions), [decisions, rows]);

  const decidedSetIds = useMemo(() => new Set(decisions.keys()), [decisions]);

  return {
    mode,
    setMode,
    queueSetId,
    setQueueSetId,
    detailPath,
    setDetailPath,
    viewerPath,
    setViewerPath,
    rows,
    decisions,
    decidedSetIds,
    proposals,
    keeperOverrides,
    chooseKeeper,
    markNotDuplicates,
    clearDecision,
    acceptProposal,
    acceptAllProposals,
    reviewedSets,
    selectedSetIds,
    toggleSetSelection,
    selectSets,
    clearSetSelection,
    selected,
    selectedRows,
    toggle,
    selectAllVisible,
    clearSelection,
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
