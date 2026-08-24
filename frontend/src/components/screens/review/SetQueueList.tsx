/**
 * The list of duplicate sets, virtualised, with the current one marked.
 *
 * Each row states what choosing it is worth — how many copies, and how much
 * comes back — because a column of names and states gives no reason to open
 * one row over another.
 */
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/I18nContext";
import type { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { isDecidedState, isProposedState } from "@/lib/duplicateDecisions";
import { formatBytes } from "@/lib/formatters";
import type { SetEntry } from "@/lib/reviewBrowse";
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
  onOpenSet,
  window,
}: {
  sets: readonly SetEntry[];
  currentId: string | null;
  openCount: number;
  onOpenSet: (setId: string) => void;
  window: ReturnType<typeof useVirtualWindow>;
}) {
  const { t, locale } = useI18n();
  return (
    <aside className="flex min-w-0 flex-col overflow-hidden border-b border-border bg-card lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <strong className="text-xs text-foreground">{t("review.resolve.allSets")}</strong>
        <Badge tone={openCount > 0 ? "primary" : "success"} className="ml-auto">
          {t("review.resolve.openCount", { count: openCount })}
        </Badge>
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
            return (
              <li
                key={entry.id}
                className="absolute inset-x-0 h-16 p-1.5"
                style={{ transform: `translateY(${virtual.start}px)` }}
              >
                <button
                  type="button"
                  onClick={() => onOpenSet(entry.id)}
                  className={cn(
                    "grid h-full w-full grid-cols-[2.625rem_minmax(0,1fr)_auto] items-center gap-2 rounded-panel p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "bg-tint-primary" : "hover:bg-muted",
                  )}
                >
                  <StackVisual paths={entry.rows.map((row) => row.source)} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-foreground">
                      {entry.keeper?.name ?? entry.rows[0]?.name ?? entry.id}
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
                  <span
                    className={cn("h-2 w-2 rounded-full", decided ? "bg-success" : "bg-primary")}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
