import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ViewMode } from "@/components/screens/review/ReviewToolbar";
import { keeperProposals, type DuplicateDecision } from "@/lib/duplicateDecisions";
import { planDuplicateSets, reviewedSetsFrom, toReviewRows } from "@/lib/reviewRows";
import { REVIEW_SORTS, type ReviewSort } from "@/lib/reviewSort";
import { dropScopedExcept, readStored, removeStored, writeStored } from "@/lib/storage";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import {
  api,
  type KeeperPolicyId,
  type PlanReviewState,
  type ReviewDecisionState,
} from "@/services/api";
import type { PreviewResult } from "@/types/api";

const VIEW_KEY = "mediasort_review_view";
const LEGACY_MODE_KEY = "mediasort_review_mode";
const SORT_KEY = "mediasort_review_sort";
const REVIEW_STATE_PREFIX = "mediasort_review_state:";

export type ReviewPersistenceState = "saving" | "saved" | "error";

function decisionEntries(state: PlanReviewState | null): Array<[string, DuplicateDecision]> {
  if (state === null) return [];
  return state.decisions.map((decision) => [
    decision.group_id,
    decision.kind === "keep_all"
      ? { kind: "keep_all" }
      : { kind: "keeper", memberId: decision.member_id! },
  ]);
}

function decisionState([groupId, decision]: [string, DuplicateDecision]): ReviewDecisionState {
  return {
    group_id: groupId,
    kind: decision.kind,
    member_id: decision.kind === "keeper" ? decision.memberId : null,
  };
}

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
  const value = readStored(key);
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
  catalogReady = true,
  recoveredState: PlanReviewState | null = null,
) {
  const [initialState] = useState<PlanReviewState | null>(() =>
    recoveredState?.config_fingerprint === result.config_fingerprint ? recoveredState : null,
  );
  const newPlanEntryRef = useRef(initialState === null);
  const [mode, setModeState] = useState<ReviewMode>(() => initialState?.mode ?? "resolve");
  /** Which set the queue is on. Null means "the first one still undecided". */
  const [queueSetId, setQueueSetId] = useState<string | null>(initialState?.queue_set_id ?? null);
  /** The file the detail view is open on, by source path. */
  const [detailPath, setDetailPath] = useState<string | null>(initialState?.detail_path ?? null);
  /** The file being examined full screen, which may be opened over the detail view. */
  const [viewerPath, setViewerPath] = useState<string | null>(initialState?.viewer_path ?? null);
  // Keeper choices, held here and sent with the run — never round-tripped.
  // They used to POST to `/api/review/decide`, which wrote a server-side plan
  // nothing read back: the refetch that followed returned identical data, so
  // the screen showed the same thing before and after every decision.
  const [decisions, setDecisions] = useState<Map<string, DuplicateDecision>>(
    () => new Map(decisionEntries(initialState)),
  );
  /** Set-level selection shared by Browse and Resolve. */
  const [selectedSetIds, setSelectedSetIds] = useState<Set<string>>(
    () => new Set(initialState?.selected_set_ids ?? []),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastToggled, setLastToggled] = useState<string | null>(null);
  const [search, setSearch] = useState(initialState?.search ?? "");
  const [treePath, setTreePath] = useState<string | null>(initialState?.tree_path ?? null);
  const [view, setViewState] = useState<ViewMode>(
    () => initialState?.view ?? stored<ViewMode>(VIEW_KEY, "list", ["list", "grid"]),
  );
  /** One order for both toolbars — see `lib/reviewSort`. */
  const [sort, setSortState] = useState<ReviewSort>(
    () => initialState?.sort ?? stored<ReviewSort>(SORT_KEY, "name", REVIEW_SORTS),
  );
  const [keepPolicy, setKeepPolicy] = useState<KeeperPolicyId>(
    initialState?.keep_policy ?? defaultKeepPolicy,
  );
  const [persistenceState, setPersistenceState] = useState<ReviewPersistenceState>("saving");
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const desiredStateRef = useRef<{ fingerprint: string; state: PlanReviewState } | null>(null);
  const savedFingerprintRef = useRef<string | null>(
    initialState === null ? null : JSON.stringify(initialState),
  );
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    // React StrictMode intentionally runs mount cleanup/setup twice in
    // development. Re-arm the guard on every setup; otherwise the first
    // cleanup leaves persistence permanently stuck in "saving".
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Delete the superseded browser-authoritative snapshot for this plan. The
  // backend envelope now owns decisions and view state; browser storage keeps
  // global preferences and one compact completed-plan pointer only.
  useEffect(() => {
    dropScopedExcept(REVIEW_STATE_PREFIX, null);
    removeStored(LEGACY_MODE_KEY);
  }, []);

  const durableState = useMemo<PlanReviewState>(
    () => ({
      schema_version: 1,
      config_fingerprint: result.config_fingerprint,
      decisions: [...decisions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(decisionState),
      selected_set_ids: [...selectedSetIds].sort(),
      mode,
      queue_set_id: queueSetId,
      detail_path: detailPath,
      viewer_path: viewerPath,
      search,
      tree_path: treePath,
      view,
      sort,
      keep_policy: keepPolicy,
    }),
    [
      decisions,
      detailPath,
      keepPolicy,
      mode,
      queueSetId,
      result.config_fingerprint,
      search,
      selectedSetIds,
      sort,
      treePath,
      view,
      viewerPath,
    ],
  );

  /** Serialise and coalesce saves so a slower older response cannot win. */
  const flushPersistence = useCallback(() => {
    if (savingRef.current || desiredStateRef.current === null) return;
    savingRef.current = true;
    void (async () => {
      while (mountedRef.current) {
        const desired = desiredStateRef.current;
        if (desired === null || desired.fingerprint === savedFingerprintRef.current) break;
        setPersistenceState("saving");
        setPersistenceError(null);
        try {
          await api.savePlanReviewState(result.plan_id, desired.state);
        } catch (cause) {
          if (mountedRef.current) {
            setPersistenceState("error");
            setPersistenceError(cause instanceof Error ? cause.message : String(cause));
          }
          savingRef.current = false;
          return;
        }
        savedFingerprintRef.current = desired.fingerprint;
      }
      savingRef.current = false;
      if (mountedRef.current) setPersistenceState("saved");
    })();
  }, [result.plan_id]);

  useEffect(() => {
    desiredStateRef.current = {
      fingerprint: JSON.stringify(durableState),
      state: durableState,
    };
    flushPersistence();
  }, [durableState, flushPersistence]);

  const retryPersistence = useCallback(() => {
    setPersistenceState("saving");
    setPersistenceError(null);
    flushPersistence();
  }, [flushPersistence]);

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
    writeStored(VIEW_KEY, next);
  }, []);

  const setMode = useCallback((next: ReviewMode) => {
    setModeState(next);
  }, []);

  const setSort = useCallback((next: ReviewSort) => {
    setSortState(next);
    writeStored(SORT_KEY, next);
  }, []);

  const rows = useMemo(
    () => toReviewRows(result, stacks, decisions, proposals),
    [decisions, proposals, result, stacks],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.source)),
    [rows, selected],
  );

  const liveSources = useMemo(() => new Set(rows.map((row) => row.source)), [rows]);

  useEffect(() => {
    setSelected((current) => {
      const valid = [...current].filter((source) => liveSources.has(source));
      return valid.length === current.size ? current : new Set(valid);
    });
    setDetailPath((current) => (current !== null && !liveSources.has(current) ? null : current));
    setViewerPath((current) => (current !== null && !liveSources.has(current) ? null : current));
  }, [liveSources]);

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
  const liveMembersBySet = useMemo(() => {
    const members = new Map<string, Set<string>>();
    for (const group of stacks) {
      members.set(
        group.group_id,
        new Set(
          group.members
            .filter((member) => member.role !== "reference")
            .map((member) => member.member_id),
        ),
      );
    }
    for (const set of planDuplicateSets(result.items)) {
      members.set(set.id, new Set(set.memberPaths));
    }
    return members;
  }, [result.items, stacks]);

  // Review is decision-first when there is work to decide. When the completed
  // catalog proves there are no duplicate sets, an empty "auto-keep 0" queue
  // is not a useful landing page, so a new plan opens its result browser. A
  // recovered plan keeps the exact view the user deliberately left behind.
  useEffect(() => {
    if (!newPlanEntryRef.current || !catalogReady) return;
    newPlanEntryRef.current = false;
    if (liveMembersBySet.size === 0) setModeState("browse");
  }, [catalogReady, liveMembersBySet]);

  const protectedSetIds = useMemo(
    () =>
      new Set(
        stacks
          .filter((group) => group.members.some((member) => member.role === "reference"))
          .map((group) => group.group_id),
      ),
    [stacks],
  );

  // Reconcile against vanished groups: a re-preview that still holds the group
  // keeps the decision, and one that does not drops it rather than sending the
  // run a path it no longer has an action for.
  useEffect(() => {
    setDecisions((current) => {
      if (current.size === 0) return current;
      const valid = [...current].filter(([id, decision]) => {
        if (protectedSetIds.has(id)) return false;
        const members = liveMembersBySet.get(id);
        // Catalog sets arrive asynchronously. Preserve their durable choices
        // until that catalog has either loaded or failed visibly; plan-derived
        // ids can be checked immediately against the frozen preview.
        if (members === undefined) return !catalogReady && !id.startsWith("plan:");
        return decision.kind === "keep_all" || members.has(decision.memberId);
      });
      return valid.length === current.size ? current : new Map(valid);
    });
    setSelectedSetIds((current) => {
      const valid = [...current].filter(
        (id) =>
          !protectedSetIds.has(id) &&
          (liveMembersBySet.has(id) || (!catalogReady && !id.startsWith("plan:"))),
      );
      return valid.length === current.size ? current : new Set(valid);
    });
    setQueueSetId((current) => {
      if (current === null) return current;
      return liveMembersBySet.has(current) || (!catalogReady && !current.startsWith("plan:"))
        ? current
        : null;
    });
  }, [catalogReady, liveMembersBySet, protectedSetIds]);

  const chooseKeeper = useCallback(
    (groupId: string, memberId: string) => {
      if (protectedSetIds.has(groupId)) return;
      setDecisions((current) => new Map(current).set(groupId, { kind: "keeper", memberId }));
    },
    [protectedSetIds],
  );

  const chooseKeepers = useCallback(
    (choices: readonly { groupId: string; memberId: string }[]) => {
      setDecisions((current) => {
        const next = new Map(current);
        for (const choice of choices) {
          if (protectedSetIds.has(choice.groupId)) continue;
          next.set(choice.groupId, { kind: "keeper", memberId: choice.memberId });
        }
        return next;
      });
    },
    [protectedSetIds],
  );

  const markNotDuplicates = useCallback(
    (groupId: string) => {
      if (protectedSetIds.has(groupId)) return;
      setDecisions((current) => new Map(current).set(groupId, { kind: "keep_all" }));
    },
    [protectedSetIds],
  );

  const markManyNotDuplicates = useCallback(
    (groupIds: readonly string[]) => {
      setDecisions((current) => {
        const next = new Map(current);
        for (const groupId of groupIds) {
          if (!protectedSetIds.has(groupId)) next.set(groupId, { kind: "keep_all" });
        }
        return next;
      });
    },
    [protectedSetIds],
  );

  const clearDecision = useCallback((groupId: string) => {
    setDecisions((current) => {
      if (!current.has(groupId)) return current;
      const next = new Map(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  const clearDecisions = useCallback((groupIds: readonly string[]) => {
    setDecisions((current) => {
      const next = new Map(current);
      let changed = false;
      for (const groupId of groupIds) changed = next.delete(groupId) || changed;
      return changed ? next : current;
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
        if (protectedSetIds.has(groupId)) continue;
        next.set(groupId, { kind: "keeper", memberId: proposal.memberId });
      }
      return next;
    });
  }, [proposals, protectedSetIds]);

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
    chooseKeepers,
    markNotDuplicates,
    markManyNotDuplicates,
    clearDecision,
    clearDecisions,
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
    sort,
    setSort,
    keepPolicy,
    setKeepPolicy,
    persistenceState,
    persistenceError,
    retryPersistence,
  };
}
