/**
 * The five figures that answer "did this go how I expected?" at a glance.
 *
 * Three of the tiles are also navigation: a tile with somewhere to go says so
 * and behaves like a link, because a number the user cares about should not
 * make them hunt for the tab that explains it. The bar underneath restates the
 * same three bands proportionally — the counts say how many, the bar says how
 * much of the library, and those are different questions.
 */

import { FiArrowRight } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { PlanTotals } from "@/lib/reviewPlan";
import type { View } from "@/lib/stageModel";

interface PlanSummaryProps {
  totals: PlanTotals;
  sizeLabel: string;
  rootCount: number;
  onOpen: (view: View) => void;
}

function Tile({
  value,
  label,
  detail,
  tone = "neutral",
  action,
}: {
  value: string;
  label: string;
  detail?: string;
  tone?: "neutral" | "ok" | "brand" | "warn";
  action?: { label: string; onClick: () => void };
}) {
  const body = (
    <>
      <span
        className={cn(
          "text-xl font-bold tracking-tight",
          tone === "ok" && "text-success",
          tone === "brand" && "text-primary",
          tone === "warn" && "text-warning",
          tone === "neutral" && "text-foreground",
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "text-xs font-semibold",
          tone === "warn" ? "text-foreground" : "text-foreground",
        )}
      >
        {label}
      </span>
      {detail && <span className="text-xs text-faint">{detail}</span>}
      {action && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-primary">
          {action.label}
          <FiArrowRight className="h-3 w-3" aria-hidden />
        </span>
      )}
    </>
  );

  const shell = cn(
    "flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl border p-3.5 text-left",
    tone === "warn" ? "border-warning bg-tint-warning" : "border-border bg-background",
  );

  if (!action) {
    return <div className={shell}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      className={cn(
        shell,
        "transition-colors hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {body}
    </button>
  );
}

export function PlanSummary({ totals, sizeLabel, rootCount, onOpen }: PlanSummaryProps) {
  const { t, locale } = useI18n();
  const n = (value: number) => value.toLocaleString(locale);
  const readyShare = totals.scanned > 0 ? Math.round((totals.ready / totals.scanned) * 100) : 0;

  return (
    <section aria-label={t("review.summary")} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Tile
          value={n(totals.scanned)}
          label={t("review.tile.scanned")}
          detail={t("review.tile.scannedDetail", { size: sizeLabel, count: rootCount })}
        />
        <Tile
          value={n(totals.ready)}
          label={t("review.tile.ready")}
          detail={t("review.tile.readyDetail", { percent: readyShare })}
          tone="ok"
        />
        <Tile
          value={n(totals.duplicates)}
          label={t("review.tile.duplicates")}
          detail={t("review.tile.duplicatesDetail", {
            resolved: n(totals.duplicatesResolved),
            unresolved: n(totals.duplicatesUnresolved),
          })}
          tone="brand"
          action={{ label: t("review.tile.openDuplicates"), onClick: () => onOpen("duplicates") }}
        />
        <Tile
          value={n(totals.junk)}
          label={t("review.tile.junk")}
          detail={t("review.tile.junkDetail")}
          action={{ label: t("review.tile.openJunk"), onClick: () => onOpen("junk") }}
        />
        {totals.warnings > 0 && (
          <Tile
            value={n(totals.warnings)}
            label={t("review.tile.warnings")}
            tone="warn"
            action={{ label: t("review.tile.openWarnings"), onClick: () => onOpen("warnings") }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex h-2 min-w-[12rem] flex-1 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={t("review.distribution", {
            ready: n(totals.ready),
            duplicates: n(totals.duplicates),
            junk: n(totals.junk),
          })}
        >
          <span className="bg-success" style={{ width: `${totals.share.ready}%` }} />
          <span className="bg-brand" style={{ width: `${totals.share.duplicates}%` }} />
          <span className="bg-warning" style={{ width: `${totals.share.junk}%` }} />
        </div>
        <ul className="flex shrink-0 gap-3.5 text-3xs text-faint">
          {(
            [
              ["bg-success", t("review.legend.organized")],
              ["bg-brand", t("review.legend.duplicates")],
              ["bg-warning", t("review.legend.junk")],
            ] as const
          ).map(([colour, label]) => (
            <li key={label} className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-sm", colour)} aria-hidden />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
