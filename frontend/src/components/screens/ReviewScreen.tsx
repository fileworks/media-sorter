/**
 * Screen 4 — the dry run. Nothing has happened yet, and this screen's whole job
 * is to make that reviewable rather than to make it reassuring.
 *
 * **Two modes, one screen, one set of state.** Browsing what the run would build
 * and adjudicating duplicate copies are not the same task: one is scanning, the
 * other is deciding one thing at a time, and asking both through a single list
 * of rows is why the reported experience was "I don't really know what to do
 * there". Switching modes loses nothing — selection, keeper choices
 * and the browsing position all live in `useReviewSurface`.
 *
 * Every figure the screen quotes comes from `reviewStats` over the same entries
 * both modes render, so the band, the tree and the queue cannot disagree about
 * how many sets are still undecided.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiChevronRight } from "react-icons/fi";

import { MediaViewer } from "@/components/screens/review/MediaViewer";
import { PlanSummary } from "@/components/screens/review/PlanSummary";
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
import { Segmented } from "@/components/ui/setting-row";
import { useReviewGroups } from "@/hooks/useReviewGroups";
import { useReviewSurface, type ReviewMode } from "@/hooks/useReviewSurface";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { isUndecidedState } from "@/lib/duplicateDecisions";
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
}

export function ReviewScreen({
  result,
  config,
  onOpenSetting,
  onRerunPreview,
  onDecisionsChange,
}: ReviewScreenProps) {
  const { t, locale } = useI18n();
  const [comparing, setComparing] = useState<Comparison | null>(null);
  const [compareRefusal, setCompareRefusal] = useState<string | null>(null);
  const [expandedSets, setExpandedSets] = useState<ReadonlySet<string>>(new Set());
  const [treeSearch, setTreeSearch] = useState("");

  const inScope = useMemo(() => new Set(result.items.map((item) => item.source)), [result.items]);
  // The sets the dry run found for itself. Computed from the plan alone so it
  // does not depend on the rows, which depend on the catalog answering.
  const planSets = useMemo(() => planDuplicateSets(result.items), [result.items]);
  const [decidedSetIds, setDecidedSetIds] = useState<ReadonlySet<string>>(new Set());
  const groups = useReviewGroups(inScope, decidedSetIds, {
    bursts: config.burst_detection_enabled,
    planSets,
    excludedRootIds: result.excluded_root_ids ?? [],
    excludedRootPaths: result.excluded_roots ?? [],
  });
  // The catalog is library-wide; the surface is this run. Keep its full groups
  // for the outside-run disclosure, and give every actionable surface only
  // groups with at least two members in the preview.
  const scopedGroups = useMemo(
    () => catalogGroupsForRun(result.items, groups.groups),
    [groups.groups, result.items],
  );
  const surface = useReviewSurface(result, scopedGroups, config.duplicate_keeper_policy);

  // The tally is scoped to this run and needs the same decisions the rows use.
  useEffect(() => setDecidedSetIds(surface.decidedSetIds), [surface.decidedSetIds]);

  // ── The one derivation ─────────────────────────────────────────────────────

  // The destination root is stripped from every planned path, so the tree shows
  // the library the run would build rather than the machine's directory layout —
  // and so contextual `_copies/` leaves and root review folders are recognised.
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

  // Execute consumes both the binding wire decisions and the one authoritative
  // outstanding count. Publishing neither until the catalog settles prevents a
  // transient empty state from opening the gate early.
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
  // The sets waiting on a person, plus one opened deliberately from Browse.
  // A baseline set is never *offered* — the reference wins and there is nothing
  // to choose — but a user who asks to see it should get the queue's view of
  // it, protection and all, rather than a control that does nothing.
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

  /**
   * The pane's own order, which is what a shift-click ranges over and what the
   * detail view walks when the file belongs to no duplicate set.
   *
   * Grouped exactly as the pane draws it, so a range never runs in an order the
   * reader cannot see. A set contributes its keeper while collapsed: the entry
   * is one thing on screen, so extending across it must not sweep up copies
   * nobody can see. Opening the set puts its copies in the pane, in this order.
   */
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

  // ── Decisions ──────────────────────────────────────────────────────────────

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

  /**
   * The bulk rule, applied only to the sets it can actually decide.
   *
   * A set the dry run found for itself is never among them: the rules rank
   * copies by measured facts — pixels, byte size, modification time — and those
   * live on the catalog's member records, which such a set has none of. Ranking
   * it on the little the plan carries would pick a keeper on grounds the user
   * was never shown, which is worse than not offering it.
   */
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

  // ── Comparing ──────────────────────────────────────────────────────────────

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
      setCompareRefusal(null);
      setComparing({
        a: comparableFor(left),
        b: comparableFor(right),
        keeperId: left.stack?.isKeeper
          ? comparableFor(left).id
          : right.stack?.isKeeper
            ? comparableFor(right).id
            : null,
        setId: sharedSet,
      });
    },
    [comparableFor],
  );

  /**
   * Compare a set against its own members, never against what is on screen.
   *
   * The old implementation searched the visible rows for a partner, so a filter
   * that hid the second copy made the button inert with no explanation. The set
   * knows its members; a set that genuinely has only one comparable copy says so.
   */
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

  // ── Resolve position ───────────────────────────────────────────────────────

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

  // ── Detail ─────────────────────────────────────────────────────────────────

  const detailRow = useMemo(
    () => surface.rows.find((row) => row.source === surface.detailPath) ?? null,
    [surface.detailPath, surface.rows],
  );
  const detailSet = useMemo(
    () =>
      detailRow?.stack
        ? ((entries.find((entry) => entry.kind === "set" && entry.id === detailRow.stack?.id) as
            | SetEntry
            | undefined) ?? null)
        : null,
    [detailRow, entries],
  );
  /**
   * What left and right walk: the copies when the file is one of several, the
   * folder's own contents otherwise.
   *
   * Both halves were already required — "a folder's visible contents, or the
   * copies in one duplicate set" — but only the set half was ever wired, so for
   * any file outside a duplicate set both arrows sat disabled beside the words
   * "not part of a duplicate set", which reads as a fault rather than a
   * boundary.
   */
  const detailScope = useMemo(
    () => (detailSet ? detailSet.rows.map((row) => row.source) : paneOrder),
    [detailSet, paneOrder],
  );
  const detailIndex = detailRow === null ? -1 : detailScope.indexOf(detailRow.source);
  const goToDetail = useCallback(
    (index: number) => surface.setDetailPath(detailScope[index] ?? null),
    [detailScope, surface],
  );

  // ── The full-screen viewer ─────────────────────────────────────────────────

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

  // ── Chrome ─────────────────────────────────────────────────────────────────

  const excludedRootIds = new Set(result.excluded_root_ids ?? []);
  const rootCount = config.library_profile.roots.filter(
    (root) => root.role !== "destination" && !excludedRootIds.has(root.root_id),
  ).length;
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

  // Depends on individual values, not on `surface`: the hook returns a fresh
  // object every render, so listing it here would tear down and re-register the
  // window listener on every keystroke, filter change and hover.
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
      // A dialog owns the first Escape. Review must not also collapse or clear
      // the surface underneath it while the shared modal stack dismisses only
      // its topmost layer.
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

  // Every figure below depends on catalog-backed set membership. Until those
  // requests answer, zero is not a fact and neither the tree nor the resolve
  // queue has a stable derivation to render.
  if (groups.isLoading) {
    return (
      <div className="space-y-5">
        <ScreenHeader title={t("review.title")} subtitle={t("review.subtitle")} />
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
        <ScreenHeader title={t("review.title")} subtitle={t("review.subtitle")} />
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
    <div className="space-y-5">
      <div>
        <ScreenHeader title={t("review.title")} subtitle={t("review.subtitle")} />
        <PlanSummary
          stats={stats}
          requiredBytes={result.impact.required_bytes}
          rootCount={rootCount}
          onResolve={() => openResolveAt(queue[0]?.id ?? null)}
        />
      </div>

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

      <Segmented
        name="review-mode"
        label={t("review.mode")}
        value={surface.mode}
        options={[
          { value: "browse" as const, label: t("review.mode.browse") },
          { value: "resolve" as const, label: t("review.mode.resolve") },
        ]}
        onChange={(mode: ReviewMode) => surface.setMode(mode)}
      />

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
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-4 lg:self-start">
            <DestinationTree
              root={tree}
              selectedPath={surface.treePath}
              onSelect={surface.setTreePath}
              outOfScopeSets={groups.tally?.outOfScope ?? 0}
              query={treeSearch}
              onQueryChange={setTreeSearch}
            />
          </div>

          <div className="min-w-0 space-y-3">
            <ReviewToolbar
              search={surface.search}
              onSearch={surface.setSearch}
              view={surface.view}
              onView={surface.setView}
              scopeLabel={scopeLabel}
            />

            {/* Where in the destination the pane is, and every way back out.
                The tree and this are one piece of state, so moving in either
                moves the other. */}
            {surface.treePath !== null && surface.treePath !== "" && (
              <nav
                aria-label={t("review.browse.trail")}
                className="flex flex-wrap items-center gap-1 text-xs"
              >
                <button
                  type="button"
                  onClick={() => surface.setTreePath(null)}
                  className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("review.tree.root")}
                </button>
                {folderTrail(surface.treePath).map((step, index, all) => (
                  <span key={step.path} className="flex items-center gap-1">
                    <FiChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
                    {index === all.length - 1 ? (
                      <span
                        aria-current="location"
                        className="px-1.5 py-0.5 font-semibold text-foreground"
                      >
                        {folderNameFor(step.path, step.name)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => surface.setTreePath(step.path)}
                        className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {folderNameFor(step.path, step.name)}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
            )}

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
                    : t("review.browse.searchMatchesNothing", { query: surface.search.trim() })
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
                onOpenDetail={surface.setDetailPath}
                onEnlarge={surface.setViewerPath}
                onResolveSet={openResolveAt}
                onKeep={chooseKeeperBySource}
                onKeepAll={keepAll}
                onCompare={compareSet}
              />
            )}
          </div>
        </div>
      )}

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
        />
      )}

      {/* Above every other layer: it is opened *from* the detail view and from a
          comparison, and closing it must return to whichever of them is behind. */}
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
