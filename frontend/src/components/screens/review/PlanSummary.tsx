/**
 * What this plan is, at a glance, and the one thing to do about it.
 *
 * It was five tiles, then three sentences. The tiles read as a dashboard — five
 * numbers of apparently equal weight — and a dashboard is the wrong shape for a
 * screen with a task. The sentences fixed the weighting and lost the scanning:
 * four figures buried mid-paragraph are four figures nobody reads.
 *
 * So the figures are figures again, but ranked rather than equal. The three
 * outcomes carry the colour of the band they occupy in the distribution bar
 * below them, which is what ties the two halves together without a legend doing
 * the work. Everything else stays prose, and exactly one thing on the card is a
 * control.
 *
 * Every figure comes from `reviewStats`, the one derivation Browse and Resolve
 * also read, so the band cannot claim a number the screen below it contradicts.
 */

import { FiArrowRight } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { ReviewStats } from "@/lib/reviewBrowse";

interface PlanSummaryProps {
  stats: ReviewStats;
  /** Bytes the run needs at the destination, as the plan reports them. */
  requiredBytes: number;
  rootCount: number;
  /** Open Resolve at the first set still waiting on a decision. */
  onResolve: () => void;
}

function Figure({
  value,
  label,
  swatch,
  muted,
}: {
  value: string;
  label: string;
  /** The distribution band this figure belongs to, or none for the total. */
  swatch?: string;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "text-xl font-semibold tabular-nums leading-none",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-3xs uppercase tracking-[0.08em] text-faint">
        {swatch && <span className={cn("h-2 w-2 shrink-0 rounded-sm", swatch)} aria-hidden />}
        <span className="min-w-0 truncate">{label}</span>
      </p>
    </div>
  );
}

export function PlanSummary({ stats, requiredBytes, rootCount, onResolve }: PlanSummaryProps) {
  const { t, locale } = useI18n();
  const n = (value: number) => value.toLocaleString(locale);
  const bytes = (value: number) => formatBytes(value, { locale });

  return (
    <section aria-label={t("review.summary")} className="rounded-xl border border-border bg-card">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-4">
        <Figure value={n(stats.scanned)} label={t("review.figure.scanned")} muted />
        <Figure
          value={n(stats.organized)}
          label={t("review.legend.organized")}
          swatch="bg-decor-success"
        />
        <Figure value={n(stats.setAside)} label={t("review.legend.setAside")} swatch="bg-brand" />
        <Figure
          value={n(stats.staysPut)}
          label={t("review.legend.stays")}
          swatch="bg-decor-warning"
        />
      </div>

      {/* The bar is the same three figures as proportions. It carries the
          legend's job, so the swatches sit on the figures instead. */}
      <div className="px-4">
        <div
          className="flex h-1.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={t("review.distribution", {
            ready: n(stats.organized),
            duplicates: n(stats.setAside),
            junk: n(stats.staysPut),
          })}
        >
          <span className="bg-decor-success" style={{ width: `${stats.share.organized}%` }} />
          <span className="bg-brand" style={{ width: `${stats.share.setAside}%` }} />
          <span className="bg-decor-warning" style={{ width: `${stats.share.staysPut}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <ul className="min-w-0 flex-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
          <li>
            {t("review.band.from", {
              folders: n(rootCount),
              size: bytes(requiredBytes),
            })}
          </li>
          <li>
            {stats.sets === 0
              ? t("review.band.noSets")
              : t("review.band.sets", {
                  sets: n(stats.sets),
                  copies: n(stats.copies),
                  size: bytes(stats.copyBytes),
                })}
          </li>
        </ul>

        {/* The one actionable figure. Zero is a statement, not a button — a
            control that does nothing when pressed is worse than its absence. */}
        {stats.outstanding === 0 ? (
          <p className="shrink-0 text-xs font-medium text-success">{t("review.band.allDecided")}</p>
        ) : (
          <button
            type="button"
            onClick={onResolve}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-tint-primary px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-tint-primary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {stats.proposed === 0
              ? t("review.band.undecided", { count: n(stats.undecided) })
              : t("review.band.outstanding", {
                  count: n(stats.outstanding),
                  proposed: n(stats.proposed),
                  undecided: n(stats.undecided),
                })}
            <FiArrowRight className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>
    </section>
  );
}
