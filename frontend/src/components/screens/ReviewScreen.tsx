/** Review the dry run and resolve duplicates before execution. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertTriangle, FiChevronRight } from "react-icons/fi";

import { MediaViewer } from "@/components/screens/review/MediaViewer";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { CompareModal } from "@/components/screens/review/CompareModal";
import { BrowseDecisionBar } from "@/components/screens/review/BrowseDecisionBar";
import { BrowsePane } from "@/components/screens/review/BrowsePane";
import { DetailView } from "@/components/screens/review/DetailView";
import { ResolveQueue } from "@/components/screens/review/ResolveQueue";
import { ReviewToolbar } from "@/components/screens/review/ReviewToolbar";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useReviewGroups } from "@/hooks/useReviewGroups";
import { useReviewSurface, type ReviewMode } from "@/hooks/useReviewSurface";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { isUndecidedState } from "@/lib/duplicateDecisions";
import { cn } from "@/lib/utils";
import {
  browseEntries,
  browseTree,
  duplicateSetEntries,
  entriesIn,
  isOpenSet,
  folderGroups,
  folderTrail,
  reviewStats,
  staysDivisionFor,
  STAYS_PATH,
  type SetEntry,
} from "@/lib/reviewBrowse";
import { sortEntries, sortRows, sortSets } from "@/lib/reviewSort";
import {
  catalogGroupsForRun,
  comparePair,
  planDuplicateSets,
  selectionActions,
  type ReviewRow,
} from "@/lib/reviewRows";

const REVIEW_FOLDER_LABEL_KEYS: Readonly<Record<string, string>> = {
  _undated: "review.folder.undated",
  _corrupted: "review.folder.corrupted",
  _junk: "review.folder.junk",
  _copies: "review.folder.copies",
};
import {
  comparableFromMember,
  comparableFromRow,
  keeperByPolicy as applyKeeperPolicy,
  memberLetter,
  pairsOf,
  type ComparableFile,
  type DuplicateGroup,
} from "@/lib/reviewWorkbench";
import type { PlanPersistenceState } from "@/hooks/usePreview";
import type { PlanReviewState } from "@/services/api";
import type { Config, PreviewResult } from "@/types/api";

interface ReviewScreenProps {
  result: PreviewResult;
  config: Config;
  /** Open Configure at the setting that produced an outcome. */
  onOpenSetting: (anchorId: string) => void;
  onRerunPreview: () => void;
  onOpenSources?: () => void;
  recoveredState?: PlanReviewState | null;
  recoveredStateSaved?: boolean;
  planPersistenceState?: PlanPersistenceState;
  planPersistenceError?: string | null;
  onRetryPlanPersistence?: () => void;
  /** Run-scoped decisions, lifted so Execute can send them with the run. */
  onDecisionsChange?: (decisions: {
    reviewedSets: { keep: string; demote: string[]; keep_all?: boolean }[];
    outstandingSets: number;
    proposedSets: number;
    undecidedSets: number;
    persistenceState: "saving" | "saved" | "error";
    persistenceError: string | null;
    reviewState: PlanReviewState;
  }) => void;
}

interface Comparison {
  /** Every copy the comparison can draw from, in the set's own order. */
  members: ComparableFile[];
  /** Which of `pairsOf(members)` is on screen. */
  pairIndex: number;
  keeperId: string | null;
  setId: string | null;
  recommendedId: string | null;
  recommendedLabel: string | null;
  recommendationReason: string | null;
  decisionLocked: boolean;
}

export function ReviewScreen({
  result,
  config,
  onOpenSetting,
  onRerunPreview,
  onOpenSources,
  recoveredState = null,
  recoveredStateSaved = true,
  planPersistenceState = "saved",
  planPersistenceError = null,
  onRetryPlanPersistence,
  onDecisionsChange,
}: ReviewScreenProps) {
  const { t, tCount, locale } = useI18n();
  const [comparing, setComparing] = useState<Comparison | null>(null);
  const [compareRefusal, setCompareRefusal] = useState<string | null>(null);
  const [expandedSets, setExpandedSets] = useState<ReadonlySet<string>>(new Set());
  const [treeSearch, setTreeSearch] = useState("");

  const inScope = useMemo(() => new Set(result.items.map((item) => item.source)), [result.items]);
  // Plan-derived sets remain available while catalog rows load.
  const planSets = useMemo(() => planDuplicateSets(result.items), [result.items]);
  const [decidedSetIds, setDecidedSetIds] = useState<ReadonlySet<string>>(new Set());
  const groups = useReviewGroups(inScope, decidedSetIds, {
    bursts: config.burst_detection_enabled,
    planSets,
  });
  // Actionable groups contain at least two members from this run.
  const scopedGroups = useMemo(
    () => catalogGroupsForRun(result.items, groups.groups),
    [groups.groups, result.items],
  );
  const surface = useReviewSurface(
    result,
    scopedGroups,
    config.duplicate_keeper_policy,
    !groups.isLoading && !groups.isError,
    recoveredState,
    recoveredStateSaved,
  );

  useEffect(() => setDecidedSetIds(surface.decidedSetIds), [surface.decidedSetIds]);

  const slowSave = useDelayedFlag(
    planPersistenceState === "saving" || surface.persistenceState === "saving",
  );

  // Strip the machine-specific destination root from the planned tree.
  const entries = useMemo(
    () => browseEntries(surface.rows, config.target_directory),
    [config.target_directory, surface.rows],
  );
  const stats = useMemo(() => reviewStats(surface.rows, entries), [entries, surface.rows]);
  // Only Browse draws the tree, and every decision invalidates it. Deciding is
  // done in Resolve, so building it there is a folder tree nobody is looking
  // at, rebuilt once per decision over the whole plan.
  const tree = useMemo(
    () =>
      surface.mode === "browse"
        ? browseTree(entries, t("review.tree.root"))
        : browseTree([], t("review.tree.root")),
    [entries, surface.mode, t],
  );
  // One order for the panel. The list is sorted by the toolbar's control while
  // the queue used entry order, so "Set 3 of 15" named a row 12 places down the
  // list and the arrow keys walked an order nothing on screen showed.
  const allSets = useMemo(
    () =>
      sortSets(duplicateSetEntries(surface.rows, config.target_directory), surface.sort, locale),
    [config.target_directory, locale, surface.rows, surface.sort],
  );

  // Do not expose a transient zero while catalog-backed decisions load.
  useEffect(() => {
    if (groups.isLoading || groups.isError) return;
    onDecisionsChange?.({
      reviewedSets: surface.reviewedSets,
      outstandingSets: stats.outstanding,
      proposedSets: stats.proposed,
      undecidedSets: stats.undecided,
      persistenceState: surface.persistenceState,
      persistenceError: surface.persistenceError,
      reviewState: surface.durableState,
    });
  }, [
    groups.isError,
    groups.isLoading,
    onDecisionsChange,
    stats.outstanding,
    stats.proposed,
    stats.undecided,
    surface.persistenceError,
    surface.persistenceState,
    surface.reviewedSets,
    surface.durableState,
  ]);
  // Every set the panel lists, in the order it lists them: "Set 3 of 15" names
  // the third row, and the total stops shrinking under the reader as decisions
  // land. Which sets are still open is a separate question, answered by the
  // open count and by "Next open".
  const queue = allSets;

  const needle = surface.search.trim().toLowerCase();
  const paneEntries = useMemo(() => {
    const scoped = entriesIn(entries, surface.treePath);
    if (needle === "") return scoped;
    const matches = (row: ReviewRow) =>
      `${row.name}\n${row.folder}\n${row.destination ?? ""}`.toLowerCase().includes(needle);
    return scoped.filter((entry) =>
      entry.kind === "file" ? matches(entry.row) : entry.rows.some(matches),
    );
  }, [entries, needle, surface.treePath]);

  /**
   * Visible order for range selection and folder-scoped detail navigation.
   *
   * Both views draw the same entries in the same order — Grid tiles them and
   * List lines them up — so this no longer branches on which one is showing.
   * It used to, because Grid reduced every subfolder to a tile you had to
   * click into; a Ctrl/Cmd+A therefore selected a different set of files
   * depending on a toggle that was supposed to be about appearance.
   */
  const paneOrder = useMemo(
    () =>
      folderGroups(paneEntries, surface.treePath).flatMap((group) =>
        sortEntries(group.entries, surface.sort, locale).flatMap((entry) => {
          if (entry.kind === "file") return [entry.row.source];
          // A collapsed set exposes only its set-level checkbox, never an
          // individual file checkbox. Ctrl/Cmd+A must follow that exact UI.
          return expandedSets.has(entry.id)
            ? sortRows(entry.rows, surface.sort, locale).map((row) => row.source)
            : [];
        }),
      ),
    [expandedSets, locale, paneEntries, surface.sort, surface.treePath],
  );

  /** Top-level duplicate sets whose selection controls are actually visible. */
  const paneSetOrder = useMemo(
    () =>
      folderGroups(paneEntries, surface.treePath).flatMap((group) =>
        sortEntries(group.entries, surface.sort, locale).flatMap((entry) =>
          entry.kind === "set" && !entry.hasBaseline ? [entry.id] : [],
        ),
      ),
    [locale, paneEntries, surface.sort, surface.treePath],
  );

  const memberIdBySetSource = useMemo(
    () =>
      new Map(
        surface.rows.flatMap((row) =>
          row.stack ? [[`${row.stack.id}\0${row.source}`, row.stack.memberId] as const] : [],
        ),
      ),
    [surface.rows],
  );

  const chooseKeeperBySource = useCallback(
    (setId: string, source: string) => {
      const memberId = memberIdBySetSource.get(`${setId}\0${source}`);
      if (memberId) surface.chooseKeeper(setId, memberId);
    },
    [memberIdBySetSource, surface],
  );

  /** The bulk form of the same choice, resolved through one member lookup. */
  const keepManyBySource = useCallback(
    (choices: readonly { setId: string; source: string }[]) =>
      surface.chooseKeepers(
        choices.flatMap((choice) => {
          const memberId = memberIdBySetSource.get(`${choice.setId}\0${choice.source}`);
          return memberId ? [{ groupId: choice.setId, memberId }] : [];
        }),
      ),
    [memberIdBySetSource, surface],
  );

  const groupFor = useCallback(
    (setId: string): DuplicateGroup | undefined =>
      scopedGroups.find((candidate) => candidate.group_id === setId),
    [scopedGroups],
  );

  /** Apply bulk rules only to sets with measured catalog facts. */
  const keepSourceByRule = useCallback(
    (setId: string, policy: import("@/services/api").KeeperPolicyId): string | null => {
      const group = groupFor(setId);
      if (group === undefined) return null;
      const memberId = applyKeeperPolicy(group, policy);
      return group.members.find((member) => member.member_id === memberId)?.observed_path ?? null;
    },
    [groupFor],
  );

  /** The sets still waiting on somebody, shared by both surfaces. */
  const openSets = useMemo(() => allSets.filter(isOpenSet), [allSets]);

  /** The set selection, resolved to entries — one derivation for both surfaces. */
  const selectedSets = useMemo(
    () => allSets.filter((entry) => surface.selectedSetIds.has(entry.id) && !entry.hasBaseline),
    [allSets, surface.selectedSetIds],
  );

  /** Sets the rule cannot decide, split by the reason it cannot. */
  const individualOnly = useMemo(() => {
    const rest = queue.filter((entry) => isUndecidedState(entry.decisionState));
    return {
      perceptual: rest.filter((entry) => entry.origin === "catalog").length,
      unmeasured: rest.filter((entry) => entry.origin === "plan").length,
    };
  }, [queue]);

  /** "These are not duplicates": every copy is kept and placed on its own. */
  const keepAll = useCallback((setId: string) => surface.markNotDuplicates(setId), [surface]);

  const comparableFor = useCallback(
    (row: ReviewRow): ComparableFile => {
      const group = row.stack ? groupFor(row.stack.id) : undefined;
      const member = group?.members.find((candidate) => candidate.observed_path === row.source);
      return member
        ? {
            ...comparableFromMember(member, row.dateSource),
            companionCount: row.companionCount,
            unitId: row.unitId,
            unitPrimary: row.unitId ? row.unitPrimary : null,
            companions: row.companions,
            unitWarnings: row.unitWarnings,
            destination: row.destination,
            plannedStatus: row.status,
          }
        : comparableFromRow(row);
    },
    [groupFor],
  );

  /**
   * Every unordered pair of a set's copies, in a stable order.
   *
   * The comparison used to hold one fixed left-hand file and cycle the right,
   * so in a set of three the second and third copies could never be put beside
   * each other — the one comparison a person reaches for once they have ruled
   * the first copy out. Walking pairs instead reaches all of them, and the
   * position says how many are left rather than implying the first copy is
   * special.
   *
   * The members are put in the screen's sort order first, because that order is
   * what the letters name. Taking them in the catalogue's own member order
   * instead let the two disagree: the queue lists a set's copies through
   * `sortRows`, so in a set whose third row on screen was the catalogue's first,
   * comparing it opened on "A" while walking to it with Next pair called the
   * same file "C". A letter has to mean the same copy in every surface that
   * shows one.
   */
  const openCompare = useCallback(
    (rows: [ReviewRow, ReviewRow] | null) => {
      if (rows === null) return;
      const [left, right] = rows;
      const sharedSet =
        left.stack !== null && left.stack.id === right.stack?.id ? left.stack.id : null;
      const sharedEntry =
        sharedSet === null ? undefined : allSets.find((entry) => entry.id === sharedSet);
      const proposedRow = sharedEntry?.proposedKeeper ?? null;
      const proposedFile = proposedRow === null ? null : comparableFor(proposedRow);
      const members = sharedEntry
        ? sortRows(sharedEntry.rows, surface.sort, locale).map((row) => comparableFor(row))
        : [comparableFor(left), comparableFor(right)];
      const pairs = pairsOf(members.length);
      const pairIndex = Math.max(
        0,
        pairs.findIndex(
          ([first, second]) =>
            (members[first].path === left.source && members[second].path === right.source) ||
            (members[first].path === right.source && members[second].path === left.source),
        ),
      );
      const confirmedRow =
        sharedEntry?.hasBaseline === true || sharedEntry?.decisionKind === "keeper"
          ? sharedEntry.keeper
          : null;
      setCompareRefusal(null);
      setComparing({
        members,
        pairIndex,
        keeperId: confirmedRow ? comparableFor(confirmedRow).id : null,
        setId: sharedSet,
        recommendedId: proposedFile?.id ?? null,
        recommendedLabel: proposedRow?.name ?? null,
        recommendationReason:
          proposedRow === null
            ? null
            : t("review.compare.recommendationReason", {
                rule: t(`config.keeper.${sharedEntry?.proposalPolicy ?? "manual"}`),
              }),
        decisionLocked: sharedEntry?.hasBaseline === true,
      });
    },
    [allSets, comparableFor, locale, surface.sort, t],
  );

  const moveComparison = useCallback((delta: number) => {
    setComparing((current) => {
      if (current === null) return current;
      const total = pairsOf(current.members.length).length;
      if (total < 2) return current;
      return { ...current, pairIndex: (current.pairIndex + delta + total) % total };
    });
  }, []);

  /** Compare a set's members independently of the current filter. */
  const compareSet = useCallback(
    (entry: SetEntry) => {
      const comparable = entry.rows.filter((row) => row.status !== "baseline");
      const first = entry.keeper ?? comparable[0] ?? entry.rows[0];
      const second = entry.rows.find((row) => row.source !== first?.source);
      if (first === undefined || second === undefined) {
        setCompareRefusal(t("review.compare.noPartner"));
        return;
      }
      openCompare([first, second]);
    },
    [openCompare, t],
  );

  /**
   * The two copies currently on screen, and every pair they came from.
   *
   * The letters are carried out with them: a comparison of four copies is six
   * comparisons, and "pair 4 of 6" says nothing about *which* four you have
   * already looked at. `A ↔ C` does.
   */
  const comparedPair = useMemo(() => {
    if (comparing === null) return null;
    const pairs = pairsOf(comparing.members.length);
    const index = Math.min(comparing.pairIndex, pairs.length - 1);
    const [first, second] = pairs[index] ?? [0, 1];
    return {
      a: comparing.members[first],
      b: comparing.members[second] ?? comparing.members[first],
      letterA: memberLetter(first),
      letterB: memberLetter(second),
      total: pairs.length,
      pairs: pairs.map(([left, right], position) => ({
        index: position,
        a: memberLetter(left),
        b: memberLetter(right),
        nameA: comparing.members[left]?.label ?? "",
        nameB: comparing.members[right]?.label ?? "",
      })),
    };
  }, [comparing]);

  const comparisonNavigation = useMemo(() => {
    if (comparing?.setId === null || comparing?.setId === undefined) {
      return { previous: null, next: null };
    }
    const comparableSets = allSets.filter((entry) => entry.rows.length >= 2);
    const index = comparableSets.findIndex((entry) => entry.id === comparing.setId);
    return {
      previous: index > 0 ? comparableSets[index - 1] : null,
      next: index >= 0 && index < comparableSets.length - 1 ? comparableSets[index + 1] : null,
    };
  }, [allSets, comparing]);

  const queueIndex = useMemo(() => {
    if (surface.queueSetId === null) return 0;
    const found = queue.findIndex((entry) => entry.id === surface.queueSetId);
    return found === -1 ? 0 : found;
  }, [queue, surface.queueSetId]);
  const currentSet = queue[queueIndex] ?? null;

  const openResolveAt = useCallback(
    (setId: string | null) => {
      surface.setQueueSetId(setId);
      surface.setMode("resolve");
    },
    [surface],
  );

  const detailRow = useMemo(
    () => surface.rows.find((row) => row.source === surface.detailPath) ?? null,
    [surface.detailPath, surface.rows],
  );
  const detailSet = useMemo(
    () =>
      detailRow?.stack
        ? ((entries.find((entry) => entry.kind === "set" && entry.id === detailRow.stack?.id) as
            SetEntry | undefined) ?? null)
        : null,
    [detailRow, entries],
  );
  /**
   * Navigate within the duplicate set, or within the visible folder otherwise.
   *
   * Sorted, like every other list of a set's copies: "copy 2 of 3" has to count
   * the same order the reader just clicked in, and `paneOrder` on the other
   * branch is already sorted.
   */
  const detailScope = useMemo(
    () =>
      detailSet
        ? sortRows(detailSet.rows, surface.sort, locale).map((row) => row.source)
        : paneOrder,
    [detailSet, locale, paneOrder, surface.sort],
  );
  const detailIndex = detailRow === null ? -1 : detailScope.indexOf(detailRow.source);
  const goToDetail = useCallback(
    (index: number) => surface.setDetailPath(detailScope[index] ?? null),
    [detailScope, surface],
  );

  const viewerRow = useMemo(
    () => surface.rows.find((row) => row.source === surface.viewerPath) ?? null,
    [surface.rows, surface.viewerPath],
  );
  const viewerScope = useMemo(() => {
    if (viewerRow === null) return [];
    const set = viewerRow.stack
      ? entries.find(
          (entry): entry is SetEntry => entry.kind === "set" && entry.id === viewerRow.stack?.id,
        )
      : undefined;
    return set ? set.rows.map((row) => row.source) : paneOrder;
  }, [entries, paneOrder, viewerRow]);
  const viewerIndex = viewerRow === null ? -1 : viewerScope.indexOf(viewerRow.source);
  const goToViewer = useCallback(
    (index: number) => surface.setViewerPath(viewerScope[index] ?? null),
    [surface, viewerScope],
  );

  const actions = selectionActions(surface.selectedRows);

  /** A folder as a person would say it, including the synthetic branches. */
  const folderNameFor = useCallback(
    (path: string, name: string) => {
      if (path === STAYS_PATH) return t("review.browse.stays");
      const division = staysDivisionFor(path);
      if (division !== null) return t(`review.browse.stays.${division}`);
      const key = REVIEW_FOLDER_LABEL_KEYS[name];
      return key === undefined ? name : t(key);
    },
    [t],
  );

  const scopeLabel =
    surface.treePath === null || surface.treePath === ""
      ? tCount("review.browse.scopeAll", paneEntries.length, {
          count: paneEntries.length.toLocaleString(locale),
        })
      : tCount("review.browse.scopeFolder", paneEntries.length, {
          folder: folderLabel(surface.treePath, t),
          count: paneEntries.length.toLocaleString(locale),
        });

  // Destructure stable dependencies; `surface` is a new object each render.
  const {
    clearSelection,
    clearSetSelection,
    selectAllVisible,
    selectSets,
    selected,
    selectedSetIds,
    setSearch,
  } = surface;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (surface.mode !== "browse" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // The modal stack owns Escape while a dialog is open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.key === "Escape") {
        if (expandedSets.size > 0) {
          event.preventDefault();
          const ordered = [...expandedSets];
          const last = ordered[ordered.length - 1];
          if (last !== undefined) {
            setExpandedSets((current) => {
              const next = new Set(current);
              next.delete(last);
              return next;
            });
          }
          return;
        }
        if (selected.size > 0 || selectedSetIds.size > 0) {
          event.preventDefault();
          clearSelection();
          clearSetSelection();
          return;
        }
        if (surface.search !== "" || treeSearch !== "") {
          event.preventDefault();
          setSearch("");
          setTreeSearch("");
        }
        return;
      }
      if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        selectAllVisible(paneOrder);
        selectSets(paneSetOrder);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    clearSetSelection,
    expandedSets,
    paneOrder,
    paneSetOrder,
    selectAllVisible,
    selectSets,
    selected,
    selectedSetIds,
    setSearch,
    surface.mode,
    surface.search,
    treeSearch,
  ]);

  // Catalog-backed membership must settle before counts are authoritative.
  if (groups.isLoading) {
    return (
      <div className="space-y-5">
        <ScreenHeader
          eyebrow={t("stage.position", { current: 5, total: 6 })}
          title={t("review.title")}
          subtitle={t("review.subtitle")}
        />
        <StateView
          variant="loading"
          title={t("review.catalog.loading")}
          detail={t("review.catalog.loadingHelp")}
        />
      </div>
    );
  }

  if (groups.isError) {
    const failure = extractErrorMessage(groups.error, t("review.stacksFailed"));
    return (
      <div className="space-y-5">
        <ScreenHeader
          eyebrow={t("stage.position", { current: 5, total: 6 })}
          title={t("review.title")}
          subtitle={t("review.subtitle")}
        />
        <StateView
          variant="error"
          title={failure.message}
          detail={t("review.stacksFailedHelp")}
          code={failure.code}
          onRetry={groups.refetch}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ScreenHeader
        eyebrow={t("stage.position", { current: 5, total: 6 })}
        title={t("review.title")}
        subtitle={t("review.subtitle")}
      />

      {(planPersistenceState === "error" || surface.persistenceState === "error") && (
        <StateView
          variant="error"
          compact
          title={t("review.persistence.title")}
          detail={
            planPersistenceError ?? surface.persistenceError ?? t("review.persistence.saveFailed")
          }
          onRetry={
            planPersistenceState === "error" ? onRetryPlanPersistence : surface.retryPersistence
          }
        />
      )}

      {/* A save that is genuinely taking time, and only that one.
          Every durable change writes to the backend, and "which dialog is open"
          is one of them — so opening a detail or compare dialog started a save
          that finished within a frame or two, and this line appeared and
          vanished in that time, shoving the whole workbench down and back up
          and briefly giving the page a scrollbar. `useDelayedFlag` waits for
          the save to be worth mentioning; the row is reserved either way, so
          saying it never moves anything. */}
      {slowSave && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("review.persistence.saving")}
        </p>
      )}

      {compareRefusal !== null && (
        <StateView
          variant="info"
          compact
          title={compareRefusal}
          action={
            <Button variant="ghost" size="sm" onClick={() => setCompareRefusal(null)}>
              {t("common.dismiss")}
            </Button>
          }
        />
      )}

      <section className="overflow-hidden rounded-window border border-border bg-card">
        <div
          className="flex h-12 items-end gap-1 border-b border-border px-3"
          role="tablist"
          aria-label={t("review.mode")}
        >
          {(
            [
              ["browse", t("review.mode.browse")],
              ["resolve", t("review.mode.resolve")],
            ] as const
          ).map(([mode, label]) => {
            const selected = surface.mode === mode;
            return (
              <button
                key={mode}
                id={`review-tab-${mode}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="review-workbench-panel"
                aria-label={label}
                tabIndex={selected ? 0 : -1}
                onClick={() => surface.setMode(mode as ReviewMode)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const nextMode: ReviewMode = mode === "browse" ? "resolve" : "browse";
                  surface.setMode(nextMode);
                  window.requestAnimationFrame(() => {
                    document.getElementById(`review-tab-${nextMode}`)?.focus();
                  });
                }}
                className={cn(
                  "relative flex h-[47px] items-center gap-2 px-3 text-xs font-semibold transition-colors",
                  "after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:bg-transparent",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "text-foreground after:bg-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {mode === "resolve" && (
                  <span
                    className={cn(
                      "min-w-5 rounded-panel px-2 py-0.5 text-center text-3xs tabular-nums",
                      stats.outstanding > 0
                        ? "bg-tint-primary text-primary"
                        : "bg-tint-success text-success",
                    )}
                  >
                    {stats.outstanding}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div
          id="review-workbench-panel"
          role="tabpanel"
          aria-labelledby={`review-tab-${surface.mode}`}
          className="bg-background"
        >
          {groups.partialIndex && (
            <StateView
              variant="partial"
              compact
              title={t("review.partialIndex.title")}
              detail={t("review.partialIndex.detail")}
            />
          )}
          {groups.truncated && (
            <p
              role="status"
              className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">
                  {t("review.truncated.title", { count: groups.groups.length })}
                </span>{" "}
                {t("review.truncated.detail")}
              </span>
            </p>
          )}
          {surface.rows.length === 0 ? (
            <StateView
              variant="empty"
              title={t("review.nothingScanned")}
              detail={t("review.nothingScannedHelp")}
              action={
                <Button size="sm" onClick={onRerunPreview}>
                  {t("preview.action")}
                </Button>
              }
            />
          ) : surface.mode === "resolve" ? (
            <ResolveQueue
              queue={queue}
              allSets={allSets}
              current={currentSet}
              index={queueIndex}
              onOpenSet={(setId) => surface.setQueueSetId(setId)}
              onKeep={chooseKeeperBySource}
              onKeepMany={keepManyBySource}
              onKeepAll={keepAll}
              onKeepAllMany={surface.markManyNotDuplicates}
              onReset={surface.clearDecision}
              onResetAll={() =>
                surface.clearDecisions(
                  allSets.filter((entry) => !entry.hasBaseline).map((entry) => entry.id),
                )
              }
              onComparePair={(a, b) => openCompare([a, b])}
              onOpenDetail={surface.setDetailPath}
              onEnlarge={surface.setViewerPath}
              onBackToBrowse={() => surface.setMode("browse")}
              rule={surface.keepPolicy}
              onRule={surface.setKeepPolicy}
              proposalCount={surface.proposals.size}
              onAcceptAllProposals={surface.acceptAllProposals}
              selectedSetIds={surface.selectedSetIds}
              onToggleSetSelection={surface.toggleSetSelection}
              onSelectSets={surface.selectSets}
              onClearSetSelection={surface.clearSetSelection}
              keepSourceByRule={keepSourceByRule}
              individualOnly={individualOnly}
              destinationRoot={config.target_directory}
              sort={surface.sort}
              onSort={surface.setSort}
            />
          ) : (
            <div className="grid min-h-[32rem] min-w-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div className="min-w-0 overflow-hidden border-b border-border bg-card lg:sticky lg:top-0 lg:self-start lg:border-b-0 lg:border-r">
                <DestinationTree
                  root={tree}
                  destinationRoot={config.target_directory}
                  selectedPath={surface.treePath}
                  onSelect={surface.setTreePath}
                  outOfScopeSets={groups.tally?.outOfScope ?? 0}
                  onOpenSources={onOpenSources}
                  revealOutOfScope={
                    (result.excluded_root_ids?.length ?? 0) > 0 ||
                    (result.excluded_roots?.length ?? 0) > 0
                  }
                  query={treeSearch}
                  onQueryChange={setTreeSearch}
                  embedded
                />
              </div>

              <div className="min-w-0">
                {/* Breadcrumbs and tree selection share one path. */}
                <div className="flex min-h-[3.25rem] flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
                  {/* Its own line below `sm`. The trail asked for 12rem and
                      the toolbar beside it for a search field and two selects
                      that will not shrink; on a 360px window the two claims
                      exceeded the row and the sort control came down on top
                      of the trail's first crumb. */}
                  <nav
                    aria-label={t("review.browse.trail")}
                    className="flex min-w-0 basis-full items-center gap-1 overflow-hidden font-mono text-3xs sm:min-w-[12rem] sm:flex-1 sm:basis-auto"
                  >
                    <button
                      type="button"
                      onClick={() => surface.setTreePath(null)}
                      className="inline-flex min-h-6 shrink-0 items-center rounded-control px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t("review.tree.root")}
                    </button>
                    {surface.treePath !== null &&
                      surface.treePath !== "" &&
                      folderTrail(surface.treePath).map((step, index, all) => (
                        <span key={step.path} className="flex min-w-0 items-center gap-1">
                          <FiChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
                          {index === all.length - 1 ? (
                            <span
                              aria-current="location"
                              className="truncate px-1 py-0.5 font-semibold text-foreground"
                            >
                              {folderNameFor(step.path, step.name)}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => surface.setTreePath(step.path)}
                              className="inline-flex min-h-6 items-center truncate rounded-control px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {folderNameFor(step.path, step.name)}
                            </button>
                          )}
                        </span>
                      ))}
                  </nav>
                  <ReviewToolbar
                    search={surface.search}
                    onSearch={surface.setSearch}
                    view={surface.view}
                    onView={surface.setView}
                    sort={surface.sort}
                    onSort={surface.setSort}
                    scopeLabel={scopeLabel}
                    selectedCount={surface.selectedRows.length}
                    onClearSelection={surface.clearSelection}
                    selectionActions={[
                      {
                        label: t("review.keepOnlyThis"),
                        enabled: actions.canKeepOnlyThis,
                        reason: actions.reasons.keepOnlyThis
                          ? t(`review.selection.reason.${actions.reasons.keepOnlyThis}`)
                          : undefined,
                        onClick: () => {
                          const row = surface.selectedRows[0];
                          if (row?.stack) chooseKeeperBySource(row.stack.id, row.source);
                        },
                      },
                      {
                        label: t("review.compare"),
                        enabled: actions.canCompare,
                        reason: actions.reasons.compare
                          ? t(`review.selection.reason.${actions.reasons.compare}`)
                          : undefined,
                        onClick: () => openCompare(comparePair(surface.selectedRows)),
                      },
                    ]}
                  />
                </div>

                <div className="space-y-2 p-2">
                  <BrowseDecisionBar
                    openSets={openSets}
                    proposalCount={surface.proposals.size}
                    undecidedCount={stats.undecided}
                    rule={surface.keepPolicy}
                    ruleLabel={t(`config.keeper.${surface.keepPolicy}`)}
                    onRule={surface.setKeepPolicy}
                    onAcceptAll={surface.acceptAllProposals}
                    selectedSets={selectedSets}
                    keepSourceByRule={keepSourceByRule}
                    onKeepMany={keepManyBySource}
                    onKeepAllMany={surface.markManyNotDuplicates}
                    onReviewSelected={() => openResolveAt([...surface.selectedSetIds][0] ?? null)}
                    onClearSelection={surface.clearSetSelection}
                  />

                  {paneEntries.length === 0 ? (
                    <StateView
                      variant="empty"
                      title={
                        needle === ""
                          ? t("review.browse.folderEmpty")
                          : t("review.browse.searchMatchesNothing", {
                              query: surface.search.trim(),
                            })
                      }
                      action={
                        needle === "" ? undefined : (
                          <Button variant="outline" size="sm" onClick={() => surface.setSearch("")}>
                            {t("review.browse.clearSearch")}
                          </Button>
                        )
                      }
                    />
                  ) : (
                    <BrowsePane
                      entries={paneEntries}
                      view={surface.view}
                      selectedPath={surface.treePath}
                      onSelectPath={surface.setTreePath}
                      folderLabel={folderNameFor}
                      selected={surface.selected}
                      selectedSetIds={surface.selectedSetIds}
                      expandedSets={expandedSets}
                      onToggleSet={(setId) =>
                        setExpandedSets((current) => {
                          const next = new Set(current);
                          if (next.has(setId)) next.delete(setId);
                          else next.add(setId);
                          return next;
                        })
                      }
                      onToggleSetSelection={surface.toggleSetSelection}
                      onToggle={(source, shiftKey) => surface.toggle(source, shiftKey, paneOrder)}
                      sort={surface.sort}
                      onOpenDetail={surface.setDetailPath}
                      onEnlarge={surface.setViewerPath}
                      onResolveSet={openResolveAt}
                      onKeep={chooseKeeperBySource}
                      onKeepAll={keepAll}
                      onCompare={compareSet}
                      destinationRoot={config.target_directory}
                      embedded
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {detailRow && (
        <DetailView
          row={detailRow}
          set={detailSet}
          scope={
            detailSet !== null
              ? { kind: "set", index: detailIndex, total: detailScope.length }
              : { kind: "folder", index: detailIndex, total: detailScope.length }
          }
          onEnlarge={() => surface.setViewerPath(detailRow.source)}
          onPrevious={detailIndex > 0 ? () => goToDetail(detailIndex - 1) : null}
          onNext={
            detailIndex >= 0 && detailIndex < detailScope.length - 1
              ? () => goToDetail(detailIndex + 1)
              : null
          }
          onKeepThis={
            detailSet !== null &&
            !detailSet.hasBaseline &&
            detailRow.stack !== null &&
            detailRow.status !== "baseline"
              ? () => {
                  chooseKeeperBySource(detailSet.id, detailRow.source);
                  surface.setDetailPath(null);
                }
              : null
          }
          onOpenInResolve={
            detailSet !== null
              ? () => {
                  surface.setDetailPath(null);
                  openResolveAt(detailSet.id);
                }
              : null
          }
          onOpenSetting={onOpenSetting}
          onRerunPreview={onRerunPreview}
          onClose={() => surface.setDetailPath(null)}
        />
      )}

      {comparing && comparedPair && (
        <CompareModal
          a={comparedPair.a}
          b={comparedPair.b}
          keeperId={comparing.keeperId}
          setId={comparing.setId}
          setMemberCount={comparing.members.length}
          recommendedId={comparing.recommendedId}
          recommendedLabel={comparing.recommendedLabel}
          recommendationReason={comparing.recommendationReason}
          decisionLocked={comparing.decisionLocked}
          onClose={() => setComparing(null)}
          onKeep={(memberId) => {
            if (comparing.setId) surface.chooseKeeper(comparing.setId, memberId);
            setComparing(null);
          }}
          onKeepBoth={() => {
            if (comparing.setId) keepAll(comparing.setId);
            setComparing(null);
          }}
          onOpenDetail={(path) => {
            setComparing(null);
            surface.setDetailPath(path);
          }}
          onEnlarge={surface.setViewerPath}
          onPreviousSet={
            comparisonNavigation.previous ? () => compareSet(comparisonNavigation.previous!) : null
          }
          onNextSet={
            comparisonNavigation.next ? () => compareSet(comparisonNavigation.next!) : null
          }
          letterA={comparedPair.letterA}
          letterB={comparedPair.letterB}
          comparisonPosition={
            comparedPair.total > 1
              ? {
                  index: Math.min(comparing.pairIndex, comparedPair.total - 1),
                  total: comparedPair.total,
                  pairs: comparedPair.pairs,
                  onPrevious: () => moveComparison(-1),
                  onNext: () => moveComparison(1),
                  onSelect: (index: number) =>
                    setComparing((current) =>
                      current === null ? current : { ...current, pairIndex: index },
                    ),
                }
              : null
          }
        />
      )}

      {/* The modal stack returns focus to the viewer's source dialog. */}
      {viewerRow && (
        <MediaViewer
          path={viewerRow.source}
          name={viewerRow.name}
          destination={viewerRow.destination}
          position={viewerIndex === -1 ? null : { index: viewerIndex, total: viewerScope.length }}
          onPrevious={viewerIndex > 0 ? () => goToViewer(viewerIndex - 1) : null}
          onNext={
            viewerIndex >= 0 && viewerIndex < viewerScope.length - 1
              ? () => goToViewer(viewerIndex + 1)
              : null
          }
          onClose={() => surface.setViewerPath(null)}
        />
      )}
    </div>
  );
}

/** A tree path as a person would say it, including the synthetic branches. */
function folderLabel(path: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (path === STAYS_PATH) return t("review.browse.stays");
  const division = staysDivisionFor(path);
  return division === null ? path : t(`review.browse.stays.${division}`);
}
