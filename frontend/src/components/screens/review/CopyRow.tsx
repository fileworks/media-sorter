/**
 * One candidate copy in a duplicate set: what it is, how it compares, and
 * whether it is the draft, the confirmed keeper, or the rule's proposal.
 */
import { FiCheck, FiLock } from "react-icons/fi";

import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { formatDate } from "@/lib/dateFormatters";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { folderLeaf, relativeDestination, type ReviewRow } from "@/lib/reviewRows";
import { cn } from "@/lib/utils";

/** One candidate with textual proposal, draft, and confirmed states. */
export function CopyRow({
  row,
  position,
  selected,
  confirmed,
  isProposed,
  note,
  onSelect,
  onOpenDetail,
  destinationRoot,
  locale,
}: {
  row: ReviewRow;
  position: number;
  selected: boolean;
  confirmed: boolean;
  isProposed: boolean;
  /** One comparative fact about this copy, or null when there is none. */
  note: string | null;
  onSelect: () => void;
  onOpenDetail: () => void;
  /** Library root, stripped from the planned destination so the cell shows the tail. */
  destinationRoot: string;
  locale: string;
}) {
  const { t } = useI18n();
  const baseline = row.status === "baseline";

  return (
    <article
      className={cn(
        // `isolate` scopes the z-indices below (the full-card select overlay,
        // the badges, the filename button above them) to this card. Without a
        // stacking context they competed page-wide, and the filename's `z-20`
        // painted over the Resolve queue's sticky decision bar at `z-10` —
        // leaving "No file selected" unreadable under a copy's name.
        "candidate-grid relative isolate min-h-[4.875rem] min-w-0 rounded-panel border bg-card px-2 py-1.5",
        "transition-[border-color,box-shadow,background-color,transform] duration-150",
        baseline ? "cursor-default" : "cursor-pointer",
        selected && "selection-set",
        selected
          ? "border-primary bg-tint-primary/50 shadow-[inset_0_0_0_1px_hsl(var(--primary))]"
          : isProposed
            ? "border-dashed border-success hover:border-border-strong"
            : "border-border hover:border-border-strong",
      )}
    >
      <div className="relative">
        <Thumbnail path={row.source} maxPx={160} className="h-[3.625rem] w-[3.625rem] rounded-md" />
        <button
          type="button"
          disabled={baseline}
          aria-describedby={baseline ? "review-baseline-rule" : undefined}
          aria-pressed={selected}
          onClick={onSelect}
          aria-label={t("review.resolve.keepThis", { name: row.name, number: position + 1 })}
          className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        />
        {/* Overlay state remains visible regardless of filename length. */}
        <span
          className={cn(
            "pointer-events-none absolute left-1 top-1 z-10 flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-bold shadow-sm",
            selected
              ? "bg-primary text-primary-foreground"
              : baseline
                ? "bg-card/90 text-muted-foreground"
                : "bg-card/90 text-muted-foreground",
          )}
        >
          {baseline ? (
            <>
              <FiLock className="h-2.5 w-2.5" aria-hidden />
              {t("review.resolve.protected")}
            </>
          ) : selected ? (
            <>
              <FiCheck className="h-2.5 w-2.5" aria-hidden />
              {confirmed ? t("review.resolve.kept") : t("review.resolve.selected")}
            </>
          ) : (
            t("review.resolve.selectThis")
          )}
        </span>
      </div>

      <div className="min-w-0">
        {/* Selection and details are disjoint targets, so neither can obscure the other's focus. */}
        <button
          type="button"
          onClick={onOpenDetail}
          className="relative z-20 flex min-h-6 w-full min-w-0 items-center truncate rounded bg-card/95 px-1 text-left text-2xs font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row.name}
        </button>
        <span className="block truncate text-3xs text-muted-foreground" title={row.folder}>
          {folderLeaf(row.folder)}
        </span>
        {note !== null && (
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1.5 truncate text-3xs leading-snug",
              isProposed ? "font-semibold text-success" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-1 w-1 shrink-0 rounded-full",
                isProposed ? "bg-success" : "bg-border-strong",
              )}
              aria-hidden
            />
            <span className="truncate">{note}</span>
          </p>
        )}
      </div>

      <span className="text-right text-3xs tabular-nums text-muted-foreground">
        {formatBytes(row.sizeBytes, { locale })}
      </span>

      <span className="candidate-date text-right text-3xs text-muted-foreground">
        {row.date === null ? t("review.resolve.noDate") : formatDate(row.date, { locale })}
      </span>

      <span className="candidate-date-source text-right text-3xs text-faint">
        {row.date === null ? "" : formatMetadataSource(row.dateSource, t)}
      </span>

      <span
        className="candidate-destination truncate font-mono text-3xs text-faint"
        title={row.destination ?? undefined}
      >
        {row.destination !== null && `→ ${relativeDestination(row.destination, destinationRoot)}`}
      </span>

      {isProposed && !selected && (
        <span className="candidate-recommendation-badge pointer-events-none absolute right-1.5 top-1.5 z-10 rounded border border-success/40 bg-tint-success px-1.5 py-0.5 text-3xs font-bold text-success">
          {t("review.resolve.recommendation")}
        </span>
      )}
    </article>
  );
}
