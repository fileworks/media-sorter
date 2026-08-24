import { useCallback, useEffect, useMemo, useState } from "react";

import type { ViewMode } from "@/components/screens/review/ReviewToolbar";
import { keeperProposals, type DuplicateDecision } from "@/lib/duplicateDecisions";
import { planDuplicateSets, reviewedSetsFrom, toReviewRows } from "@/lib/reviewRows";
import { REVIEW_SORTS, type ReviewSort } from "@/lib/reviewSort";
import { dropScopedExcept, readStored, writeStored } from "@/lib/storage";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/services/api";
import type { PreviewResult } from "@/types/api";

const VIEW_KEY = "mediasort_review_view";
const MODE_KEY = "mediasort_review_mode";
const SORT_KEY = "mediasort_review_sort";
const REVIEW_STATE_PREFIX = "mediasort_review_state:";

interface PersistedReviewState {
  schemaVersion: 2;
  planId: string;
  configFingerprint: string;
  decisions: Array<[string, DuplicateDecision]>;
  selectedSetIds: string[];
  mode: ReviewMode;
  queueSetId: string | null;
  detailPath: string | null;
  viewerPath: string | null;
  search: string;
  treePath: string | null;
  view: ViewMode;
  sort: ReviewSort;
  keepPolicy: KeeperPolicyId;
}

function reviewStateKey(planId: string): string {
  return `${REVIEW_STATE_PREFIX}${planId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDecision(value: unknown): value is DuplicateDecision {
  if (!isRecord(value)) return false;
  if (value.kind === "keep_all") return Object.keys(value).length === 1;
  return (
    value.kind === "keeper" &&
    typeof value.memberId === "string" &&
    value.memberId.length > 0 &&
    Object.keys(value).every((key) => key === "kind" || key === "memberId")
  );
}

function isDecisionEntries(value: unknown): value is Array<[string, DuplicateDecision]> {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length === 0 ||
      ids.has(entry[0]) ||
      !isDecision(entry[1])
    ) {
      return false;
    }
    ids.add(entry[0]);
    return true;
  });
}

function readReviewState(planId: string, configFingerprint: string): PersistedReviewState | null {
  const raw = readStored(reviewStateKey(planId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const valid =
      parsed.schemaVersion === 2 &&
      parsed.planId === planId &&
      parsed.configFingerprint === configFingerprint &&
      isDecisionEntries(parsed.decisions) &&
      isStringArray(parsed.selectedSetIds) &&
      (parsed.mode === "browse" || parsed.mode === "resolve") &&
      isNullableString(parsed.queueSetId) &&
      isNullableString(parsed.detailPath) &&
      isNullableString(parsed.viewerPath) &&
      typeof parsed.search === "string" &&
      isNullableString(parsed.treePath) &&
      (parsed.view === "list" || parsed.view === "grid") &&
      typeof parsed.sort === "string" &&
      (REVIEW_SORTS as readonly string[]).includes(parsed.sort) &&
      typeof parsed.keepPolicy === "string" &&
      (SELECTABLE_KEEPER_POLICIES as readonly string[]).includes(parsed.keepPolicy);
    return valid ? (parsed as unknown as PersistedReviewState) : null;
  } catch {
    return null;
  }
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
) {
  const [initialState] = useState<PersistedReviewState | null>(() =>
    readReviewState(result.plan_id, result.config_fingerprint),
  );
  const [mode, setModeState] = useState<ReviewMode>(
    () => initialState?.mode ?? stored<ReviewMode>(MODE_KEY, "browse", ["browse", "resolve"]),
  );
  /** Which set the queue is on. Null means "the first one still undecided". */
  const [queueSetId, setQueueSetId] = useState<string | null>(initialState?.queueSetId ?? null);
  /** The file the detail view is open on, by source path. */
  const [detailPath, setDetailPath] = useState<string | null>(initialState?.detailPath ?? null);
  /** The file being examined full screen, which may be opened over the detail view. */
  const [viewerPath, setViewerPath] = useState<string | null>(initialState?.viewerPath ?? null);
  // Keeper choices, held here and sent with the run — never round-tripped.
  // They used to POST to `/api/review/decide`, which wrote a server-side plan
  // nothing read back: the refetch that followed returned identical data, so
  // the screen showed the same thing before and after every decision.
  const [decisions, setDecisions] = useState<Map<string, DuplicateDecision>>(
    () => new Map(initialState?.decisions ?? []),
  );
  /** Set-level selection shared by Browse and Resolve. */
  const [selectedSetIds, setSelectedSetIds] = useState<Set<string>>(
    () => new Set(initialState?.selectedSetIds ?? []),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastToggled, setLastToggled] = useState<string | null>(null);
  const [search, setSearch] = useState(initialState?.search ?? "");
  const [treePath, setTreePath] = useState<string | null>(initialState?.treePath ?? null);
  const [view, setViewState] = useState<ViewMode>(
    () => initialState?.view ?? stored<ViewMode>(VIEW_KEY, "list", ["list", "grid"]),
  );
  /** One order for both toolbars — see `lib/reviewSort`. */
  const [sort, setSortState] = useState<ReviewSort>(
    () => initialState?.sort ?? stored<ReviewSort>(SORT_KEY, "name", REVIEW_SORTS),
  );
  const [keepPolicy, setKeepPolicy] = useState<KeeperPolicyId>(
    initialState?.keepPolicy ?? defaultKeepPolicy,
  );
  const [hydratedPlanId, setHydratedPlanId] = useState<string | null>(result.plan_id);

  useEffect(() => {
    const saved = readReviewState(result.plan_id, result.config_fingerprint);
    setDecisions(new Map(saved?.decisions ?? []));
    setSelectedSetIds(new Set(saved?.selectedSetIds ?? []));
    // Without a snapshot for this plan the durable *preferences* still apply:
    // resetting them to the hardcoded defaults would silently discard the
    // user's chosen mode, layout, and order on every new plan.
    setModeState(saved?.mode ?? stored<ReviewMode>(MODE_KEY, "browse", ["browse", "resolve"]));
    setQueueSetId(saved?.queueSetId ?? null);
    setDetailPath(saved?.detailPath ?? null);
    setViewerPath(saved?.viewerPath ?? null);
    setSearch(saved?.search ?? "");
    setTreePath(saved?.treePath ?? null);
    setViewState(saved?.view ?? stored<ViewMode>(VIEW_KEY, "list", ["list", "grid"]));
    setSortState(saved?.sort ?? stored<ReviewSort>(SORT_KEY, "name", REVIEW_SORTS));
    setKeepPolicy(saved?.keepPolicy ?? defaultKeepPolicy);
    setHydratedPlanId(result.plan_id);
  }, [defaultKeepPolicy, result.config_fingerprint, result.plan_id]);

  useEffect(() => {
    if (hydratedPlanId !== result.plan_id) return;
    const state: PersistedReviewState = {
      schemaVersion: 2,
      planId: result.plan_id,
      configFingerprint: result.config_fingerprint,
      decisions: [...decisions.entries()],
      selectedSetIds: [...selectedSetIds],
      mode,
      queueSetId,
      detailPath,
      viewerPath,
      search,
      treePath,
      view,
      sort,
      keepPolicy,
    };
    writeStored(reviewStateKey(result.plan_id), JSON.stringify(state));
    // One plan is reviewable at a time; every earlier plan's snapshot is dead
    // weight that would otherwise grow until the quota refused this write.
    dropScopedExcept(REVIEW_STATE_PREFIX, result.plan_id);
  }, [
    decisions,
    detailPath,
    hydratedPlanId,
    keepPolicy,
    mode,
    queueSetId,
    result.config_fingerprint,
    result.plan_id,
    search,
    selectedSetIds,
    sort,
    treePath,
    view,
    viewerPath,
  ]);

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
    writeStored(MODE_KEY, next);
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

  const markNotDuplicates = useCallback(
    (groupId: string) => {
      if (protectedSetIds.has(groupId)) return;
      setDecisions((current) => new Map(current).set(groupId, { kind: "keep_all" }));
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
    sort,
    setSort,
    keepPolicy,
    setKeepPolicy,
  };
}
