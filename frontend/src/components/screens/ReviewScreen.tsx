/** Review the dry run and resolve duplicates before execution. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiChevronRight } from "react-icons/fi";

import { MediaViewer } from "@/components/screens/review/MediaViewer";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { CompareModal } from "@/components/screens/review/CompareModal";
import { BrowsePane } from "@/components/screens/review/BrowsePane";
import { DetailView } from "@/components/screens/review/DetailView";
import { ResolveQueue } from "@/components/screens/review/ResolveQueue";
import { ReviewToolbar } from "@/components/screens/review/ReviewToolbar";
import { SelectionBar } from "@/components/screens/review/SelectionBar";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
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
  folderGroups,
  folderTrail,
  resolveQueue,
  reviewStats,
  staysDivisionFor,
  STAYS_PATH,
  type SetEntry,
} from "@/lib/reviewBrowse";
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
  type ComparableFile,
  type DuplicateGroup,
} from "@/lib/reviewWorkbench";
import type { Config, PreviewResult } from "@/types/api";

interface ReviewScreenProps {
  result: PreviewResult;
  config: Config;
  /** Jump to Configure, scrolled to a specific setting row. */
  onOpenSetting: (anchorId: string) => void;
  onRerunPreview: () => void;
  onOpenSources?: () => void;
  /** Run-scoped decisions, lifted so Execute can send them with the run. */
  onDecisionsChange?: (decisions: {
    reviewedSets: { keep: string; demote: string[]; keep_all?: boolean }[];
    outstandingSets: number;
    proposedSets: number;
    undecidedSets: number;
  }) => void;
}

interface Comparison {
  a: ComparableFile;
  b: ComparableFile;
  keeperId: string | null;
  setId: string | null;
  recommendedId: string | null;
  recommendedLabel: string | null;
  recommendationReason: string | null;
}

export function ReviewScreen({
  result,
  config,
  onOpenSetting,
  onRerunPreview,
  onOpenSources,
  onDecisionsChange,
}: ReviewScreenProps) {
  const { t, locale } = useI18n();
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
  const surface = useReviewSurface(result, scopedGroups, config.duplicate_keeper_policy);

  useEffect(() => setDecidedSetIds(surface.decidedSetIds), [surface.decidedSetIds]);

  // Strip the machine-specific destination root from the planned tree.
  const entries = useMemo(
    () => browseEntries(surface.rows, config.target_directory),
    [config.target_directory, surface.rows],
  );
  const stats = useMemo(() => reviewStats(surface.rows, entries), [entries, surface.rows]);
  const tree = useMemo(() => browseTree(entries, t("review.tree.root")), [entries, t]);
  const allSets = useMemo(
    () => duplicateSetEntries(surface.rows, config.target_directory),
    [config.target_directory, surface.rows],
  );

  // Do not expose a transient zero while catalog-backed decisions load.
  useEffect(() => {
    if (groups.isLoading || groups.isError) return;
    onDecisionsChange?.({
      reviewedSets: surface.reviewedSets,
      outstandingSets: stats.outstanding,
      proposedSets: stats.proposed,
      undecidedSets: stats.undecided,
    });
  }, [
    groups.isError,
    groups.isLoading,
    onDecisionsChange,
    stats.outstanding,
    stats.proposed,
    stats.undecided,
    surface.reviewedSets,
  ]);
  // Include a resolved set when Browse explicitly opens it in the queue.
  const queue = useMemo(() => {
    const waiting = resolveQueue(entries);
    if (surface.queueSetId === null || waiting.some((entry) => entry.id === surface.queueSetId)) {
      return waiting;
    }
    const opened = allSets.find((entry) => entry.id === surface.queueSetId);
    return opened ? [...waiting, opened] : waiting;
  }, [allSets, entries, surface.queueSetId]);

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

  /** Visible order for range selection and folder-scoped detail navigation. */
  const paneOrder = useMemo(
    () =>
      folderGroups(paneEntries, surface.treePath).flatMap((group) =>
        group.entries.flatMap((entry) =>
          entry.kind === "file"
            ? [entry.row.source]
            : expandedSets.has(entry.id)
              ? entry.rows.map((row) => row.source)
              : entry.keeper
                ? [entry.keeper.source]
                : [],
        ),
      ),
    [expandedSets, paneEntries, surface.treePath],
  );

  const chooseKeeperBySource = useCallback(
    (setId: string, source: string) => {
      const row = surface.rows.find((candidate) => candidate.source === source);
      if (row?.stack) surface.chooseKeeper(setId, row.stack.memberId);
    },
    [surface],
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
      return member ? comparableFromMember(member, row.dateSource) : comparableFromRow(row);
    },
    [groupFor],
  );

  /** Any two files. Only a shared set unlocks choosing a keeper from here. */
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
      const leftFile = comparableFor(left);
      const rightFile = comparableFor(right);
      const confirmedRow =
        sharedEntry?.hasBaseline === true || sharedEntry?.decisionKind === "keeper"
          ? sharedEntry.keeper
          : null;
      setCompareRefusal(null);
      setComparing({
        a: leftFile,
        b: rightFile,
        keeperId:
          confirmedRow?.source === left.source
            ? leftFile.id
            : confirmedRow?.source === right.source
              ? rightFile.id
              : null,
        setId: sharedSet,
        recommendedId: proposedFile?.id ?? null,
        recommendedLabel: proposedRow?.name ?? null,
        recommendationReason:
          proposedRow === null
            ? null
            : t("review.compare.recommendationReason", {
                rule: t(`config.keeper.${sharedEntry?.proposalPolicy ?? "manual"}`),
              }),
      });
    },
    [allSets, comparableFor, t],
  );

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

  const goToQueue = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, queue.length - 1));
      surface.setQueueSetId(queue[clamped]?.id ?? null);
    },
    [queue, surface],
  );

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
  /** Navigate within the duplicate set, or within the visible folder otherwise. */
  const detailScope = useMemo(
    () => (detailSet ? detailSet.rows.map((row) => row.source) : paneOrder),
    [detailSet, paneOrder],
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
      ? t("review.browse.scopeAll", { count: paneEntries.length.toLocaleString(locale) })
      : t("review.browse.scopeFolder", {
          folder: folderLabel(surface.treePath, t),
          count: paneEntries.length.toLocaleString(locale),
        });

  // Destructure stable dependencies; `surface` is a new object each render.
  const {
    clearSelection,
    clearSetSelection,
    selectAllVisible,
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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    clearSetSelection,
    expandedSets,
    paneOrder,
    selectAllVisible,
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

      <section className="overflow-hidden rounded-xl border border-border bg-card">
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
                      "min-w-5 rounded-md px-1.5 py-0.5 text-center text-3xs tabular-nums",
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
              onGo={goToQueue}
              onOpenSet={(setId) => surface.setQueueSetId(setId)}
              onKeep={chooseKeeperBySource}
              onKeepAll={keepAll}
              onAcceptProposal={surface.acceptProposal}
              onCompare={compareSet}
              onOpenDetail={surface.setDetailPath}
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
              <div className="min-w-0 overflow-hidden border-b border-border bg-card lg:border-b-0 lg:border-r">
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
                  <nav
                    aria-label={t("review.browse.trail")}
                    className="flex min-w-[12rem] flex-1 items-center gap-1 overflow-hidden font-mono text-3xs"
                  >
                    <button
                      type="button"
                      onClick={() => surface.setTreePath(null)}
                      className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                              className="truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                  />
                </div>

                <div className="space-y-2 p-2">
                  <SelectionBar
                    selected={surface.selectedRows}
                    actions={actions}
                    onKeepOnlyThis={() => {
                      const row = surface.selectedRows[0];
                      if (row?.stack) chooseKeeperBySource(row.stack.id, row.source);
                    }}
                    onCompare={() => openCompare(comparePair(surface.selectedRows))}
                    onClear={surface.clearSelection}
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
            detailSet !== null && detailRow.stack !== null && detailRow.status !== "baseline"
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

      {comparing && (
        <CompareModal
          a={comparing.a}
          b={comparing.b}
          keeperId={comparing.keeperId}
          setId={comparing.setId}
          recommendedId={comparing.recommendedId}
          recommendedLabel={comparing.recommendedLabel}
          recommendationReason={comparing.recommendationReason}
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
