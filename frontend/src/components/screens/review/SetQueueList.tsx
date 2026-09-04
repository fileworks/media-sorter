/**
 * The list of duplicate sets, virtualised, with the current one marked.
 *
 * Each row states what choosing it is worth — how many copies, and how much
 * comes back — because a column of names and states gives no reason to open
 * one row over another.
 *
 * Its header carries the controls that act on the *list* and on nothing else:
 * what order it is in, walking to the next set still open, and clearing every
 * decision in it. They used to sit in the strip above, beside the keep rule,
 * where they had nothing to do with the set on screen and where their wrapping
 * is what made that strip change height when a checkbox was ticked. Selecting
 * the list is not one of them: a selection is decided in the strip, so both
 * halves of that gesture belong there.
 */
import { FiArrowRight, FiCheck, FiFilter } from "react-icons/fi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortControl } from "@/components/screens/review/SortControl";
import { useI18n } from "@/i18n/I18nContext";
import type { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { isDecidedState, isProposedState } from "@/lib/duplicateDecisions";
import { formatBytes } from "@/lib/formatters";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewSort } from "@/lib/reviewSort";
import { cn } from "@/lib/utils";

import { StackVisual } from "@/components/screens/review/StackVisual";

/**
 * What deciding this set frees: every copy except the one that would be kept.
 *
 * The keeper stays wherever it is planned to go, so it is not a saving. Where
 * no keeper is settled yet, the largest copy is assumed to be the one kept —
 * the same assumption the default rule makes.
 */
function reclaimableBytes(entry: SetEntry): number | null {
  if (entry.rows.some((row) => row.sizeBytes === null)) return null;
  const sizes = entry.rows.map((row) => row.sizeBytes ?? 0);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const kept = entry.keeper?.sizeBytes ?? Math.max(...sizes, 0);
  return Math.max(0, total - kept);
}

export function SetQueueList({
  sets,
  currentId,
  openCount,
  decidedCount,
  selectedSetIds,
  onToggleSetSelection,
  onOpenSet,
  sort,
  onSort,
  onResetAll,
  hasNextOpen,
  onNextOpen,
  scopedCount,
  onClearScope,
  window,
}: {
  sets: readonly SetEntry[];
  currentId: string | null;
  openCount: number;
  decidedCount: number;
  /** The bulk-action selection, so the list shows what a bulk action covers. */
  selectedSetIds: ReadonlySet<string>;
  onToggleSetSelection: (setId: string) => void;
  onOpenSet: (setId: string) => void;
  sort: ReviewSort;
  onSort: (sort: ReviewSort) => void;
  /** Optional: the panel omits it where nothing can be reset. */
  onResetAll?: () => void;
  hasNextOpen: boolean;
  onNextOpen: () => void;
  /**
   * How many sets stepping is currently confined to; 0 when it walks them all.
   *
   * The list still shows every set — the selection narrows what the arrows and
   * "next" traverse, it does not filter what can be read — so the band has to
   * say so, or "next" quietly skipping most of the list looks like a bug.
   */
  scopedCount: number;
  onClearScope: () => void;
  window: ReturnType<typeof useVirtualWindow>;
}) {
  const { t, tCount, locale } = useI18n();
  return (
    <aside className="flex min-w-0 flex-col overflow-hidden border-b border-border bg-card lg:border-b-0 lg:border-r">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <strong className="text-xs text-foreground">{t("review.resolve.allSets")}</strong>
          <Badge tone={openCount > 0 ? "primary" : "success"} className="ml-auto">
            {t("review.resolve.openCount", { count: openCount })}
          </Badge>
        </div>
        {/* One wrapping row, in reading order, with nothing pushed to an edge.
            Three controls in a 17rem rail cannot all fit on one line, and an
            `ml-auto` on the middle one made them break into a ragged stagger
            with a lone button stranded on the right. They wrap as a group. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SortControl
            id="review-resolve-sort"
            value={sort}
            onChange={onSort}
            className="min-w-0"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasNextOpen}
            aria-describedby={
              hasNextOpen
                ? undefined
                : scopedCount > 0
                  ? "review-nothing-open-in-selection"
                  : "review-nothing-open"
            }
            onClick={onNextOpen}
          >
            {scopedCount > 0 ? t("review.resolve.nextInSelection") : t("review.resolve.nextOpen")}
            <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decidedCount === 0}
            aria-describedby={decidedCount === 0 ? "review-nothing-decided" : undefined}
            onClick={onResetAll}
          >
            {t("review.resolve.resetAll")}
          </Button>
        </div>
        {/* Says what the two controls above are walking, and undoes it in the
            same place. Without this the arrows silently skipping most of the
            list below reads as a fault rather than as the selection working. */}
        {/* Stacked, not a row: at 18.5rem a sentence and a link beside it break
            into a three-line stagger. */}
        {scopedCount > 0 && (
          <div className="mt-2 rounded-panel border border-primary/40 bg-tint-primary px-2 py-1.5">
            <p className="flex items-start gap-1.5 text-3xs text-foreground">
              <FiFilter className="mt-px h-3 w-3 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0">{tCount("review.resolve.scopeChip", scopedCount)}</span>
            </p>
            <button
              type="button"
              onClick={onClearScope}
              className="mt-1 rounded-control text-3xs font-semibold text-primary underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("review.resolve.scopeClear")}
            </button>
          </div>
        )}
        {!hasNextOpen && scopedCount > 0 && (
          <p id="review-nothing-open-in-selection" className="sr-only">
            {t("review.resolve.nothingOpenInSelection")}
          </p>
        )}
      </div>
      <div
        ref={window.scrollRef}
        onScroll={window.onScroll}
        className="max-h-[min(32rem,60dvh)] overflow-y-auto overscroll-contain lg:max-h-none lg:flex-1"
      >
        <ul className="relative" style={{ height: window.totalSize }}>
          {window.virtualItems.map((virtual) => {
            const entry = sets[virtual.index];
            if (entry === undefined) return null;
            const active = currentId === entry.id;
            const decided = entry.hasBaseline || isDecidedState(entry.decisionState);
            const proposed = isProposedState(entry.decisionState);
            const selectable = !entry.hasBaseline;
            const selected = selectable && selectedSetIds.has(entry.id);
            const name = entry.keeper?.name ?? entry.rows[0]?.name ?? entry.id;
            return (
              <li
                key={entry.id}
                className="absolute inset-x-0 h-16 p-2"
                style={{ transform: `translateY(${virtual.start}px)` }}
              >
                {/* A row, not a button: the checkbox is a second control with a
                    different job, and nesting one inside a button is neither
                    valid nor operable. */}
                <div
                  data-set-row={entry.id}
                  data-selected={selected || undefined}
                  className={cn(
                    "relative flex h-full items-center rounded-panel transition-colors",
                    // Three claims, three treatments, and they compose: the set
                    // being read, the sets a bulk action would cover, and the
                    // rest. A selection that only showed in the strip above left
                    // "decide 5 sets" naming five rows nothing on screen marked.
                    active ? "bg-tint-primary" : selected ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  {/* A drawn pill, not an inset box-shadow: a shadow follows the
                      row's 10px radius and tapered the rail to a crescent. Same
                      marker, same 3px, as the Configure rail's current entry. */}
                  {selected && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary"
                    />
                  )}
                  {/* `min-h-6` on the wrapper: the control itself is 14px,
                      which is under the 24px SC 2.5.8 floor, so the label it
                      sits in carries the target. */}
                  {selectable && (
                    <label className="grid h-full min-h-6 w-6 shrink-0 cursor-pointer place-items-center">
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={t("review.setSelection.toggle", { name })}
                        onChange={() => onToggleSetSelection(entry.id)}
                        className="h-3.5 w-3.5 rounded-control border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenSet(entry.id)}
                    className={cn(
                      "grid h-full min-w-0 flex-1 grid-cols-[2.625rem_minmax(0,1fr)_auto] items-center gap-2 rounded-panel p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !selectable && "ml-6",
                    )}
                  >
                    <StackVisual paths={entry.rows.map((row) => row.source)} />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block truncate text-xs font-semibold",
                          // A decided set has had its turn. Keeping it at full
                          // weight leaves a finished queue looking like an
                          // unfinished one.
                          decided ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {name}
                      </span>
                      {/* Enough to choose between rows: how many copies, and
                        what deciding this one is worth. Fifteen rows of a
                        name and a state give no reason to open any of
                        them, which is what makes a long queue feel like
                        work rather than progress. */}
                      <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                        {t("review.stack.copies", { count: entry.rows.length })}
                        {" · "}
                        {formatBytes(reclaimableBytes(entry), { locale })}
                        {" · "}
                        {decided
                          ? t("review.resolve.queueDecided")
                          : proposed
                            ? t("review.resolve.queueProposed")
                            : entry.setKind === "exact"
                              ? t("review.stack.match.exact")
                              : entry.setKind === "similar" && entry.similarity !== null
                                ? t("review.stack.match.similar", {
                                    percent: entry.similarity,
                                  })
                                : t(`review.stack.kind.${entry.setKind}`)}
                      </span>
                    </span>
                    {/* A dot is a claim on attention: this row still wants
                      something from you. A decided set wants nothing, so it
                      does not get one — it gets a check, which is the shape of
                      "done" rather than a fourth colour of "look here". The two
                      open states keep their own colours, the same two the set
                      header and the tree use; a proposal wearing the decided
                      green made a queue of untaken offers look finished. */}
                    {decided ? (
                      <FiCheck className="h-3.5 w-3.5 shrink-0 text-success/70" aria-hidden />
                    ) : (
                      <span
                        aria-hidden
                        className={cn(
                          "h-2 w-2 rounded-full",
                          proposed ? "bg-suggest" : "bg-primary",
                        )}
                      />
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
