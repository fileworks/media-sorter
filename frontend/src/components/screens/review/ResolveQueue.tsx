/**
 * The decision queue: one duplicate set at a time, and the copies inside it.
 *
 * Choosing a keeper used to take two gestures — activate a copy to draft it,
 * then press "Confirm selection" in a bar at the bottom of the pane. That bar
 * was the only place the set could actually be decided, so the decision lived
 * as far from the copies as the layout allowed, and fifteen sets cost thirty
 * presses. It also contradicted the surface's own contract: a keeper is chosen
 * *by activating the copy*, and there must be no separate command control that
 * acts on a set without naming the copy it would choose.
 *
 * So the three things a person does here — keep this one, compare it against
 * another, say these are not duplicates — are on the copies and immediately
 * under them, and every one of them is a single press. None of those is
 * confirmed, because none of them is irreversible: a decision states itself
 * where it was taken and can be cleared in one press from the same place.
 *
 * "Clear all decisions" is the one exception, and it is an exception for the
 * reason the others are not: undoing it means finding and re-deciding every
 * set by hand. One press, no dialog, and an afternoon of choices was gone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiChevronRight } from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  AcceptRecommendationsDialog,
  SelectionDecisionsDialog,
} from "@/components/screens/review/BulkDecideDialog";
import { CopyRow } from "@/components/screens/review/CopyRow";
import { ResolveToolbar } from "@/components/screens/review/ResolveToolbar";
import { SetQueueList } from "@/components/screens/review/SetQueueList";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useI18n } from "@/i18n/I18nContext";
import { isDecidedState, type RationaleMessage } from "@/lib/duplicateDecisions";
import { formatBytes, formatCount } from "@/lib/formatters";
import { isOpenSet, type SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";
import { sortRows, type ReviewSort } from "@/lib/reviewSort";
import type { KeeperPolicyId } from "@/types/api";

/** Derive one factual comparison note without inferring media quality. */
function candidateNote(
  row: ReviewRow,
  rows: readonly ReviewRow[],
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string | null {
  const knownSizes = rows.flatMap((candidate) =>
    candidate.sizeBytes === null ? [] : [candidate.sizeBytes],
  );
  const largest = knownSizes.length > 0 ? Math.max(...knownSizes) : null;
  const dated = rows.filter((candidate) => candidate.date !== null);
  const newest = dated.reduce<string | null>(
    (latest, candidate) => (latest === null || candidate.date! > latest ? candidate.date : latest),
    null,
  );
  const isNewest =
    newest !== null && row.date === newest && dated.some((other) => other.date !== newest);

  if (row.sizeBytes !== null && row.sizeBytes === largest && largest > 0) {
    const smaller = knownSizes.some((size) => size < largest);
    if (smaller) {
      return isNewest
        ? t("review.resolve.note.largestAndNewest")
        : t("review.resolve.note.largest");
    }
  } else if (largest !== null && row.sizeBytes !== null && largest > row.sizeBytes) {
    return t("review.resolve.note.smallerBy", {
      amount: formatBytes(largest - row.sizeBytes, { locale }),
    });
  }
  return isNewest ? t("review.resolve.note.newest") : null;
}

/**
 * One line of the ranking, with every number written the reader's way.
 *
 * The rationale is built without a locale — it has to be, because the ranking
 * is a pure function of the facts — so its parameters arrive as raw numbers. A
 * pixel count printed as `784154` is not a number anybody reads; grouping is
 * applied here, where the locale is known. Pixel dimensions are the exception:
 * `3024 × 4032` is a pair of labels rather than a quantity, and grouping them
 * makes them harder to recognise.
 */
function rationaleText(
  message: RationaleMessage,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  if (message.params === undefined) return t(message.key);
  const params = Object.fromEntries(
    Object.entries(message.params).map(([name, value]) => {
      if (typeof value !== "number") return [name, value];
      if (name === "bytes") return [name, formatBytes(value, { locale })];
      if (name === "width" || name === "height") return [name, String(value)];
      return [name, formatCount(value, locale)];
    }),
  );
  return t(message.key, params);
}

/**
 * The copy a row's Compare opens against.
 *
 * For a pair — which is most duplicate sets — that is simply the other copy,
 * so comparing two copies is one press from either of them. Beyond a pair it
 * is the copy currently in the running: the settled keeper, else the rule's
 * recommendation, else the first other copy. The comparison itself can then
 * walk the remaining members from inside the dialog.
 */
function comparePartner(entry: SetEntry, row: ReviewRow): ReviewRow | null {
  const others = entry.rows.filter((candidate) => candidate.source !== row.source);
  if (others.length === 0) return null;
  if (others.length === 1) return others[0];
  const running = entry.keeper ?? entry.proposedKeeper;
  return running !== null && running.source !== row.source ? running : others[0];
}

interface ResolveQueueProps {
  queue: SetEntry[];
  allSets: SetEntry[];
  current: SetEntry | null;
  index: number;
  onOpenSet: (setId: string) => void;
  onKeep: (setId: string, source: string) => void;
  onKeepMany?: (choices: readonly { setId: string; source: string }[]) => void;
  onKeepAll: (setId: string) => void;
  onKeepAllMany?: (setIds: readonly string[]) => void;
  onReset?: (setId: string) => void;
  onResetAll?: () => void;
  /** Compare any two copies, from the pair of rows that named them. */
  onComparePair: (a: ReviewRow, b: ReviewRow) => void;
  onOpenDetail: (source: string) => void;
  /** Look at one copy full screen. */
  onEnlarge: (source: string) => void;
  onBackToBrowse: () => void;
  rule: KeeperPolicyId;
  onRule: (rule: KeeperPolicyId) => void;
  proposalCount: number;
  onAcceptAllProposals: () => void;
  selectedSetIds: ReadonlySet<string>;
  onToggleSetSelection: (setId: string) => void;
  onSelectSets: (setIds: readonly string[]) => void;
  onClearSetSelection: () => void;
  keepSourceByRule: (setId: string, rule: KeeperPolicyId) => string | null;
  individualOnly: { perceptual: number; unmeasured: number };
  /** Library root, stripped from destinations so rows show the tail. */
  destinationRoot: string;
  /** The screen-wide order, shared with Browse. */
  sort: ReviewSort;
  onSort: (sort: ReviewSort) => void;
}

export function ResolveQueue({
  queue,
  allSets,
  current,
  index,
  onOpenSet,
  onKeep,
  onKeepMany,
  onKeepAll,
  onKeepAllMany,
  onReset,
  onResetAll,
  onComparePair,
  onOpenDetail,
  onEnlarge,
  onBackToBrowse,
  rule,
  onRule,
  proposalCount,
  onAcceptAllProposals,
  selectedSetIds,
  onToggleSetSelection,
  onSelectSets,
  onClearSetSelection,
  keepSourceByRule,
  individualOnly,
  destinationRoot,
  sort,
  onSort,
}: ResolveQueueProps) {
  const { t, tCount, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [bulkScope, setBulkScope] = useState<"selection" | "recommendations" | null>(null);
  const [resetAllAsked, setResetAllAsked] = useState(false);

  const currentResolved =
    current !== null && (current.hasBaseline || isDecidedState(current.decisionState));
  /** "Not duplicates" keeps every copy; a keeper decision keeps exactly one. */
  const currentDistinct = current?.decisionKind === "keep_all";
  const soleKeeper =
    current !== null && (current.hasBaseline || current.decisionKind === "keeper")
      ? (current.keeper?.source ?? null)
      : null;

  // `allSets` arrives in the panel's one order — the list, the position
  // indicator and the arrow keys all read it, so it is not re-sorted here.
  const orderedSets = allSets;
  const setWindow = useVirtualWindow({
    count: orderedSets.length,
    estimateSize: 64,
    maxHeight: 512,
    overscan: 6,
    anchorKey: orderedSets[0]?.id ?? null,
  });

  // Opening a set from Browse also brings its row into the virtualized index.
  useEffect(() => {
    if (current === null || setWindow.scrollRef.current === null) return;
    const currentIndex = orderedSets.findIndex((entry) => entry.id === current.id);
    if (currentIndex < 0) return;
    const top = currentIndex * 64;
    const bottom = top + 64;
    const element = setWindow.scrollRef.current;
    const moveTo = (nextTop: number) => {
      if (typeof element.scrollTo === "function") element.scrollTo({ top: nextTop });
      else element.scrollTop = nextTop;
    };
    if (top < element.scrollTop) moveTo(top);
    else if (bottom > element.scrollTop + element.clientHeight) {
      moveTo(bottom - element.clientHeight);
    }
  }, [current, orderedSets, setWindow.scrollRef]);

  const selectableSetIds = useMemo(
    () => allSets.filter((entry) => !entry.hasBaseline).map((entry) => entry.id),
    [allSets],
  );
  const selectedSets = useMemo(
    () => allSets.filter((entry) => selectedSetIds.has(entry.id) && !entry.hasBaseline),
    [allSets, selectedSetIds],
  );

  const applyKeepers = useCallback(
    (choices: readonly { setId: string; source: string }[]) => {
      if (onKeepMany) onKeepMany(choices);
      else for (const choice of choices) onKeep(choice.setId, choice.source);
    },
    [onKeep, onKeepMany],
  );

  const applyKeepAll = useCallback(
    (setIds: readonly string[]) => {
      if (onKeepAllMany) onKeepAllMany(setIds);
      else for (const setId of setIds) onKeepAll(setId);
    },
    [onKeepAll, onKeepAllMany],
  );

  // Memoize the full-queue scan for bulk-action rerenders.
  const openSets = useMemo(() => allSets.filter(isOpenSet), [allSets]);
  const openCount = openSets.length;
  const decidedCount = allSets.length - openCount;

  /**
   * The list stepping actually walks.
   *
   * Ticking sets is already how this screen says "these are the ones I mean" —
   * every bulk action reads exactly that selection. Stepping ignored it, so
   * picking six sets out of two hundred and then working through them meant
   * finding each one again by hand in the list. While a selection exists the
   * arrows, the keyboard and "next" all follow it; with none, they walk the
   * whole queue as before. It is the same two controls either way, which is
   * why the rail says which of the two is in force.
   */
  const scoped = selectedSets.length > 0;
  const navSets = scoped ? selectedSets : queue;
  const navIndex = current === null ? -1 : navSets.findIndex((entry) => entry.id === current.id);
  /* Out of scope — the reader opened a set that is not ticked. Going back is
     meaningless there, so only "forward into the selection" is offered. */
  const navPrevious = navIndex > 0 ? (navSets[navIndex - 1] ?? null) : null;
  const navNext = navIndex < 0 ? (navSets[0] ?? null) : (navSets[navIndex + 1] ?? null);

  // Find the next open set in one pass, wrapping once, within the scope.
  const nextOpen = useMemo(() => {
    const pool = scoped ? selectedSets : allSets;
    const openInPool = pool.filter(isOpenSet);
    if (current === null) return openInPool[0];
    const from = pool.findIndex((entry) => entry.id === current.id);
    for (let i = from + 1; i < pool.length; i += 1) {
      if (isOpenSet(pool[i])) return pool[i];
    }
    return openInPool.find((entry) => entry.id !== current.id);
  }, [allSets, current, scoped, selectedSets]);

  /**
   * Decide this set, then move to the next one still open.
   *
   * A queue that stays put after a decision makes every set cost two gestures
   * — decide, then navigate — and fifteen sets forty-five clicks. The set just
   * decided keeps its place in the list, so ← walks straight back to it, and
   * the last decision advances nowhere and lets the finished state show.
   */
  const decideAndAdvance = useCallback(
    (decide: () => void) => {
      const following = nextOpen;
      decide();
      if (following !== undefined && following.id !== current?.id) onOpenSet(following.id);
    },
    [current?.id, nextOpen, onOpenSet],
  );

  /**
   * Decide this set by keeping one copy — advancing only if it was still open.
   *
   * Correcting a set you have already decided is not the same act as deciding
   * one, and moving the queue on afterwards takes the reader away from the set
   * they came back to look at.
   */
  const keepCopy = useCallback(
    (source: string) => {
      if (current === null) return;
      if (isOpenSet(current)) decideAndAdvance(() => onKeep(current.id, source));
      else onKeep(current.id, source);
    },
    [current, decideAndAdvance, onKeep],
  );

  const chooseByNumber = useCallback(
    (position: number): boolean => {
      const row = current?.rows[position];
      if (row === undefined || row.status === "baseline") return false;
      keepCopy(row.source);
      return true;
    },
    [current, keepCopy],
  );

  // Activating Resolve moves focus into the queue, the standard tab-to-panel
  // behaviour. Without it the shortcuts below — now scoped to focus-within —
  // would be dead until the user tabbed in, which is how a correct
  // accessibility fix turns into a usability regression.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // WCAG 2.1.4 (Character Key Shortcuts, Level A): a shortcut bound to a single
  // unmodified character must be switchable off, remappable, or **active only
  // while the relevant component has focus**. This takes the third option.
  //
  // Widening the tag-exclusion list below would not have satisfied it. The
  // criterion is about *where focus is*, not about which element type happens
  // to swallow the key — and this queue commits keeper decisions, so a stray
  // `3` typed at a button elsewhere on the screen used to change which file the
  // next confirmation would keep.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (container === null || !container.contains(document.activeElement)) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        (target?.tagName === "INPUT" &&
          !["button", "checkbox", "radio", "range", "submit"].includes(
            (target as HTMLInputElement).type,
          ))
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // The same two steps the header's arrows take, so the keyboard and the
      // pointer cannot disagree about what "next set" means under a selection.
      if (event.key === "ArrowRight" && navNext !== null) {
        event.preventDefault();
        onOpenSet(navNext.id);
      } else if (event.key === "ArrowLeft" && navPrevious !== null) {
        event.preventDefault();
        onOpenSet(navPrevious.id);
      } else if (/^[1-9]$/.test(event.key) && chooseByNumber(Number(event.key) - 1)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseByNumber, navNext, navPrevious, onOpenSet]);

  const proposedRow = current?.rows.find((row) => row.stack?.isProposedKeeper === true) ?? null;
  const candidates = current === null ? [] : sortRows(current.rows, sort, locale);

  return (
    // `tabIndex={-1}` so the queue is a focus target in its own right: the
    // shortcuts above are scoped to focus-within, and a region the user cannot
    // focus is a region whose shortcuts they could never reach.
    <div ref={containerRef} tabIndex={-1} className="outline-none">
      {/* Why a control that looks available is not. Referenced by the toolbar's
          disabled buttons, so the reason is read rather than merely implied by
          a paler colour. */}
      <p id="review-no-proposals" className="sr-only">
        {t("review.resolve.noProposals")}
      </p>
      <p id="review-nothing-decided" className="sr-only">
        {t("review.resolve.nothingDecided")}
      </p>
      <p id="review-nothing-open" className="sr-only">
        {t("review.resolve.nothingOpen")}
      </p>

      <ResolveToolbar
        rule={rule}
        onRule={onRule}
        openCount={openCount}
        decidedCount={decidedCount}
        totalSets={allSets.length}
        proposalCount={proposalCount}
        onAcceptAllProposals={() => setBulkScope("recommendations")}
        selectableSetIds={selectableSetIds}
        onSelectSets={onSelectSets}
        selectedCount={selectedSets.length}
        onOpenBulk={() => setBulkScope("selection")}
        onClearSelection={onClearSetSelection}
      />

      <AcceptRecommendationsDialog
        open={bulkScope === "recommendations"}
        openSets={openSets}
        proposalCount={proposalCount}
        rule={rule}
        ruleLabel={t(`config.keeper.${rule}`)}
        onRule={onRule}
        onAccept={onAcceptAllProposals}
        onClose={() => setBulkScope(null)}
      />
      {/* Finished, said across the top of the whole surface.
          Finishing is stated where the work was, not by replacing it: every set
          stays reachable afterwards, so a decision can still be read back or
          changed without hunting for the way in again. It used to sit inside
          the right-hand pane, above whichever set happened to be open, where it
          was both narrower than the thing it was reporting on and the first
          thing to scroll away — so the answer to "am I done?" was somewhere in
          a scroller rather than at the top of the screen. */}
      {openCount === 0 && allSets.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-success/40 bg-tint-success px-3 py-2"
        >
          <FiCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">{t("review.resolve.doneTitle")}</p>
            <p className="mt-0.5 text-3xs text-muted-foreground">{t("review.resolve.doneHelp")}</p>
          </div>
          <Button size="sm" variant="outline" onClick={onBackToBrowse}>
            <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("review.resolve.backToBrowse")}
          </Button>
        </div>
      )}

      <SelectionDecisionsDialog
        open={bulkScope === "selection"}
        sets={selectedSets}
        rule={rule}
        ruleLabel={t(`config.keeper.${rule}`)}
        onRule={onRule}
        keepSourceByRule={keepSourceByRule}
        onKeepMany={applyKeepers}
        onKeepAllMany={applyKeepAll}
        onClose={() => setBulkScope(null)}
      />

      {/* The count is the point of the question: "clear all decisions" does not
          say whether that is one choice or ninety. */}
      <ConfirmDialog
        open={resetAllAsked}
        title={t("review.resolve.resetAll.title")}
        description={tCount("review.resolve.resetAll.description", decidedCount)}
        confirmLabel={t("review.resolve.resetAll.confirm")}
        cancelLabel={t("common.cancel")}
        onClose={() => setResetAllAsked(false)}
        onConfirm={() => {
          setResetAllAsked(false);
          onResetAll?.();
        }}
      />

      {/* On a wide screen the workspace is bounded by the viewport and each
          pane scrolls inside it, so the decision controls are never left under
          the pinned footer and the list never scrolls the page out from under
          the set being read. Narrow screens keep the natural flow, where one
          column and one scroll are the right answer.

          The rail is 18.5rem rather than 17: each row now carries a selection
          checkbox as well as its stack, name and figures, and at the old width
          the last of those figures — "proposal waiting", the row's own state —
          was the one that got truncated away. */}
      <div className="grid min-h-[32rem] min-w-0 lg:h-[calc(100dvh-theme(spacing.actionzone)-21rem)] lg:min-h-[26rem] lg:grid-cols-[18.5rem_minmax(0,1fr)]">
        <SetQueueList
          sets={orderedSets}
          currentId={current?.id ?? null}
          openCount={openCount}
          decidedCount={decidedCount}
          selectedSetIds={selectedSetIds}
          onToggleSetSelection={onToggleSetSelection}
          onOpenSet={onOpenSet}
          sort={sort}
          onSort={onSort}
          onResetAll={onResetAll === undefined ? undefined : () => setResetAllAsked(true)}
          hasNextOpen={nextOpen !== undefined}
          onNextOpen={() => {
            if (nextOpen !== undefined) onOpenSet(nextOpen.id);
          }}
          scopedCount={scoped ? selectedSets.length : 0}
          onClearScope={onClearSetSelection}
          window={setWindow}
        />

        {/* `scroll-pb-*` matches the pinned decision footer: without it the
            browser scrolls a focused copy to the bottom edge, where that
            footer covers it (WCAG 2.4.11). Same reason `main` carries
            `scroll-pb-actionzone`. */}
        <div className="min-w-0 overflow-y-auto overscroll-contain lg:scroll-pb-28">
          {current === null ? (
            <div className="grid min-h-80 place-items-center p-3 text-center">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t("review.resolve.emptyTitle")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t("review.resolve.doneHelp")}</p>
                <Button size="sm" variant="outline" className="mt-4" onClick={onBackToBrowse}>
                  <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  {t("review.resolve.backToBrowse")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              {/* A sticky band has to look like one: padded on every side, ruled
                  at the bottom, and bled to the pane's edges with a negative
                  margin so nothing passes beside it. */}
              <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 lg:sticky lg:top-0 lg:z-10 lg:shadow-[0_1px_0_hsl(var(--border))]">
                {/* Two lines, not three. The match kind was its own eyebrow
                    above the name and the position its own sentence below it,
                    so identifying one set cost three stacked rows of a band
                    that is on screen the whole time. */}
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                  <h2
                    id="review-queue-position"
                    className="truncate text-sm font-semibold text-foreground"
                  >
                    {current.keeper?.name ?? current.rows[0]?.name ?? current.id}
                  </h2>
                  <p className="mt-0.5 truncate text-3xs text-muted-foreground">
                    {current.setKind === "exact"
                      ? t("review.stack.match.exact")
                      : current.setKind === "similar" && current.similarity !== null
                        ? t("review.stack.match.similar", { percent: current.similarity })
                        : t(`review.stack.kind.${current.setKind}`)}
                    {" · "}
                    {/* Counted within whatever the arrows are walking. A set
                        outside the current selection has no place in it, so it
                        keeps its position in the full queue. */}
                    {navIndex >= 0
                      ? t("review.resolve.position", {
                          index: navIndex + 1,
                          total: navSets.length,
                        })
                      : t("review.resolve.position", { index: index + 1, total: queue.length })}
                    {" · "}
                    {t("review.stack.copies", { count: current.rows.length })}
                  </p>
                </div>
                {/* This labelled selection feeds the bulk actions. */}
                {/* `min-h-6` rather than `target-24`: this label carries visible
                    text, so its own box is the target and only needed height
                    (WCAG 2.2 SC 2.5.8). */}
                <label className="mt-0.5 flex min-h-6 cursor-pointer items-center gap-2 whitespace-nowrap text-3xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={selectedSetIds.has(current.id)}
                    aria-label={t("review.setSelection.toggle", {
                      name: current.keeper?.name ?? current.id,
                    })}
                    onChange={() => onToggleSetSelection(current.id)}
                    className="h-3.5 w-3.5 rounded-control border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {t("review.setSelection.forBulk")}
                </label>
                <Tooltip label={t("review.resolve.previous")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={navPrevious === null}
                    onClick={() => navPrevious && onOpenSet(navPrevious.id)}
                    aria-label={t("review.resolve.previous")}
                  >
                    <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Tooltip>
                <Tooltip label={t("review.resolve.next")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={navNext === null}
                    onClick={() => navNext && onOpenSet(navNext.id)}
                    aria-label={t("review.resolve.next")}
                  >
                    <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Tooltip>
              </header>

              <div className="p-3">
                {/* The recommendation, said in one line, with its full ranking one
                  press away. It used to be a six-field panel taller than two of
                  the copies it was ranking. */}
                {proposedRow && (
                  <aside
                    aria-label={t("review.resolve.recommendationLabel")}
                    className="mb-3 rounded-panel border border-suggest/40 bg-tint-suggest px-3 py-2"
                  >
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-foreground">
                      <strong className="font-semibold">
                        {t("review.resolve.recommended", { name: proposedRow.name })}
                      </strong>
                      <span className="text-3xs text-muted-foreground">
                        {t("review.resolve.recommendationHelp", {
                          rule: t(`config.keeper.${current.proposalPolicy ?? rule}`),
                        })}
                      </span>
                    </p>
                    {current.proposalRationale && (
                      <details className="group mt-1">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-3xs font-semibold text-suggest underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <FiChevronRight
                            className="h-3 w-3 transition-transform group-open:rotate-90"
                            aria-hidden
                          />
                          {t("review.resolve.rationale.show")}
                        </summary>
                        <dl className="mt-2 grid gap-1 text-3xs text-muted-foreground sm:grid-cols-2">
                          <div>
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.primaryRung")}
                            </dt>
                            <dd>
                              {rationaleText(current.proposalRationale.primaryRung, t, locale)}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.winningRung")}
                            </dt>
                            <dd>
                              {rationaleText(current.proposalRationale.winningRung, t, locale)}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.knownFacts")}
                            </dt>
                            <dd>
                              {current.proposalRationale.knownFacts
                                .map((fact) => rationaleText(fact, t, locale))
                                .join(", ")}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.unknownFacts")}
                            </dt>
                            <dd>
                              {current.proposalRationale.unknownFacts.length > 0
                                ? current.proposalRationale.unknownFacts
                                    .map((fact) => rationaleText(fact, t, locale))
                                    .join(", ")
                                : t("review.resolve.rationale.none")}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.tieBreak")}
                            </dt>
                            <dd>
                              {current.proposalRationale.tieBreak
                                ? rationaleText(current.proposalRationale.tieBreak, t, locale)
                                : t("review.resolve.rationale.none")}
                            </dd>
                          </div>
                          {current.proposalRationale.limitation && (
                            <div className="sm:col-span-2">
                              <dt className="font-semibold text-foreground">
                                {t("review.resolve.rationale.limitation")}
                              </dt>
                              <dd>
                                {rationaleText(current.proposalRationale.limitation, t, locale)}
                              </dd>
                            </div>
                          )}
                          <div className="sm:col-span-2">
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.comparedFacts")}
                            </dt>
                            <dd>
                              <ul className="mt-0.5 space-y-0.5">
                                {current.proposalRationale.comparisons.map((comparison) => (
                                  <li key={comparison.member}>
                                    <span
                                      className={
                                        comparison.selected
                                          ? "font-semibold text-suggest"
                                          : undefined
                                      }
                                    >
                                      {comparison.member}
                                      {comparison.selected
                                        ? ` (${t("review.resolve.rationale.selected")})`
                                        : ""}
                                    </span>
                                    {": "}
                                    {comparison.values
                                      .map((fact) => {
                                        // A pixel count is a number a person
                                        // reads, so it is grouped the way their
                                        // language groups numbers — 784,154 or
                                        // 784.154, never a bare 784154.
                                        const value =
                                          fact.value === null
                                            ? t("review.detail.unknown")
                                            : typeof fact.value !== "number"
                                              ? String(fact.value)
                                              : fact.format === "bytes"
                                                ? formatBytes(fact.value, { locale })
                                                : fact.format === "number"
                                                  ? formatCount(fact.value, locale)
                                                  : String(fact.value);
                                        return `${rationaleText(fact.rung, t, locale)}: ${value}`;
                                      })
                                      .join("; ")}
                                  </li>
                                ))}
                              </ul>
                            </dd>
                          </div>
                        </dl>
                      </details>
                    )}
                  </aside>
                )}

                {/* Keep each duplicate set as one vertical comparison list. */}
                <ul className="grid gap-2">
                  {candidates.map((row) => {
                    const partner = comparePartner(current, row);
                    return (
                      <li key={row.source}>
                        <CopyRow
                          row={row}
                          // Shortcut numbers follow stable set order.
                          position={current.rows.indexOf(row)}
                          kept={currentDistinct || soleKeeper === row.source}
                          keepDisabled={soleKeeper === row.source}
                          isProposed={row.stack?.isProposedKeeper === true}
                          note={candidateNote(row, current.rows, t, locale)}
                          compareWith={partner?.name ?? null}
                          onKeep={() => keepCopy(row.source)}
                          onCompare={() => {
                            if (partner !== null) onComparePair(row, partner);
                          }}
                          onEnlarge={() => onEnlarge(row.source)}
                          onOpenDetail={() => onOpenDetail(row.source)}
                          destinationRoot={destinationRoot}
                          locale={locale}
                        />
                      </li>
                    );
                  })}
                </ul>

                {(individualOnly.perceptual > 0 || individualOnly.unmeasured > 0) && (
                  <div className="mt-2 space-y-1 text-3xs text-muted-foreground">
                    {individualOnly.perceptual > 0 && (
                      <p>{tCount("review.resolve.individualOnly", individualOnly.perceptual)}</p>
                    )}
                    {individualOnly.unmeasured > 0 && (
                      <p>{tCount("review.resolve.unmeasuredOnly", individualOnly.unmeasured)}</p>
                    )}
                  </div>
                )}
              </div>

              {/* What the set has been decided to do, and the two decisions that
                  are not about one copy. A band, like the header: both are
                  direct children of the scroller, so `top` and `bottom` land on
                  the scrollport instead of inside the pane's padding — which is
                  what left a strip of rows sliding past above the header. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card px-3 py-2 lg:sticky lg:bottom-0 lg:z-10 lg:shadow-[0_-1px_0_hsl(var(--border))]">
                <div className="mr-auto min-w-0" aria-live="polite">
                  <strong className="block text-xs text-foreground">
                    {current.decisionKind === "keep_all"
                      ? t("review.resolve.resolvedAll")
                      : currentResolved
                        ? t("review.resolve.resolvedKeeping", {
                            name: current.keeper?.name ?? current.id,
                          })
                        : t("review.resolve.notConfirmed")}
                  </strong>
                  <span className="block text-3xs text-muted-foreground">
                    {current.hasBaseline
                      ? t("review.resolve.baselineWins")
                      : current.decisionKind === "keep_all"
                        ? t("review.resolve.resolvedAllHelp")
                        : currentResolved
                          ? tCount(
                              "review.resolve.resolvedHelp",
                              Math.max(0, current.rows.length - 1),
                            )
                          : t("review.resolve.chooseHelp")}
                  </span>
                  <span className="mt-0.5 hidden text-3xs text-faint lg:block">
                    {t("review.resolve.keyboardHelp")}
                  </span>
                </div>
                {!current.hasBaseline && (
                  <>
                    {currentResolved ? (
                      <Button size="sm" variant="ghost" onClick={() => onReset?.(current.id)}>
                        {t("review.resolve.resetOne")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={current.decisionKind === "keep_all"}
                      aria-describedby={
                        current.decisionKind === "keep_all"
                          ? "review-already-not-duplicates"
                          : undefined
                      }
                      onClick={() => {
                        if (isOpenSet(current)) decideAndAdvance(() => onKeepAll(current.id));
                        else onKeepAll(current.id);
                      }}
                    >
                      {t("review.resolve.keepAll")}
                    </Button>
                  </>
                )}
                {currentResolved && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={nextOpen === undefined}
                    aria-describedby={nextOpen === undefined ? "review-nothing-open" : undefined}
                    onClick={() => nextOpen && onOpenSet(nextOpen.id)}
                  >
                    {t("review.resolve.nextOpen")}
                  </Button>
                )}
                <p id="review-already-not-duplicates" className="sr-only">
                  {t("review.resolve.resolvedAllHelp")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
