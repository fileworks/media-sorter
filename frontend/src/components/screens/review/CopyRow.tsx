/**
 * One candidate copy in a duplicate set, and the three things a person does
 * with it: keep it, compare it against another copy, or open it.
 *
 * The row used to be a six-column grid — thumbnail, name, size, date, date
 * source, planned destination — with the whole card acting as one big radio
 * button and the actual decision living in a bar at the bottom of the pane.
 * Between byte-identical copies four of those six columns are the same value
 * printed twice, so the columns that answer "which one is this?" — where it
 * came from, and when — got the same weight as the ones that answer nothing.
 *
 * So the folder leads, on its own line at reading size; the date, the size and
 * the destination follow it in one quiet line; and the decision is a button on
 * the copy it decides. Nothing here reports a state it does not also let you
 * change.
 */
import { FiLock, FiRepeat } from "react-icons/fi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { formatDate } from "@/lib/dateFormatters";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { folderTail, relativeDestination, type ReviewRow } from "@/lib/reviewRows";
import { cn } from "@/lib/utils";

export function CopyRow({
  row,
  position,
  kept,
  keepDisabled,
  isProposed,
  note,
  compareWith,
  onKeep,
  onCompare,
  onEnlarge,
  onOpenDetail,
  destinationRoot,
  locale,
}: {
  row: ReviewRow;
  /** Stable position in the set, which is also the keyboard shortcut. */
  position: number;
  /** This copy survives the set's decision — as its keeper, or as one of all. */
  kept: boolean;
  /** Keeping it again would change nothing: it is already the sole keeper. */
  keepDisabled: boolean;
  /** The keep rule ranks this copy first, and nobody has answered yet. */
  isProposed: boolean;
  /** One comparative fact about this copy, or null when there is none. */
  note: string | null;
  /** The copy this row's Compare would open against, for its label. */
  compareWith: string | null;
  onKeep: () => void;
  onCompare: () => void;
  /** Look at this copy full screen — what a picture is for. */
  onEnlarge: () => void;
  /** Open its facts and provenance, from the name rather than the picture. */
  onOpenDetail: () => void;
  /** Library root, stripped from the planned destination so the row shows the tail. */
  destinationRoot: string;
  locale: string;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";
  // The date leads, because between identical copies it is the one number
  // that can differ; size and destination follow it on the same line, because
  // for an exact set they are the same value printed once per copy.
  const facts = [
    row.date === null
      ? t("review.resolve.noDate")
      : t("review.resolve.dated", {
          date: formatDate(row.date, { locale }),
          source: formatMetadataSource(row.dateSource, t),
        }),
    formatBytes(row.sizeBytes, { locale }),
    row.destination === null ? null : `→ ${relativeDestination(row.destination, destinationRoot)}`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <article
      data-copy-row={row.source}
      data-copy-state={locked ? "protected" : kept ? "kept" : isProposed ? "proposed" : "open"}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border bg-card px-3 py-2",
        "transition-[border-color,background-color] duration-150",
        kept || locked
          ? "border-success bg-tint-success"
          : isProposed
            ? "border-dashed border-suggest bg-tint-suggest"
            : "border-border",
      )}
    >
      {/* The picture opens the picture. Activating a thumbnail anywhere else
          on this screen enlarges it; here it used to open a facts dialog, so
          the one gesture the whole surface is about behaved differently on the
          one screen devoted to looking at images. The name opens the facts. */}
      <Thumbnail
        path={row.source}
        maxPx={160}
        className="h-14 w-14 shrink-0 rounded-panel"
        onOpen={onEnlarge}
        openLabel={t("review.viewer.open", { name: row.name })}
      />

      <div className="min-w-0 flex-1 basis-32">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenDetail}
            // `min-h-6` and real side padding: a text-only button measured
            // 123x18 and failed WCAG 2.2 SC 2.5.8. The negative margin keeps
            // the name optically flush with the lines under it.
            className="-mx-1 flex min-h-6 min-w-0 items-center truncate rounded-control px-1 text-left text-xs font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.name}
          </button>
          {locked ? (
            <Badge tone="success" className="gap-1">
              <FiLock className="h-2.5 w-2.5" aria-hidden />
              {t("review.resolve.protected")}
            </Badge>
          ) : kept ? (
            <Badge tone="success">{t("review.resolve.kept")}</Badge>
          ) : isProposed ? (
            <Badge tone="suggest">{t("review.resolve.recommendation")}</Badge>
          ) : null}
        </div>

        {/* What actually separates two copies of the same bytes: the folder it
            was found in. At reading size, on its own line, directly under the
            name — the six-column grid this replaced gave it the same weight as
            three columns that are identical across the whole set. */}
        <p className="mt-0.5 truncate text-2xs text-foreground" title={row.folder}>
          {folderTail(row.folder)}
        </p>
        <p className="truncate text-3xs text-muted-foreground" title={row.destination ?? undefined}>
          {facts.join(" · ")}
        </p>

        {note !== null && (
          <p
            className={cn(
              "mt-0.5 truncate text-3xs font-semibold",
              isProposed ? "text-suggest" : "text-muted-foreground",
            )}
          >
            {note}
          </p>
        )}
      </div>

      {/* Below `sm` the actions take their own row rather than squeezing the
          folder they are being chosen against down to a column of letters. */}
      <div className="flex basis-full items-center gap-2 sm:basis-auto">
        {locked ? (
          <p className="flex items-center gap-2 text-3xs font-semibold text-muted-foreground">
            <FiLock className="h-3 w-3 shrink-0" aria-hidden />
            {t("review.stack.baselineHelp")}
          </p>
        ) : (
          // A set marked "not duplicates" keeps every copy, so every copy is
          // kept — but choosing one of them is still a decision the reader is
          // allowed to make, and disabling the control on all of them made the
          // only way back out of that state a separate reset.
          <Button
            size="sm"
            variant={kept ? "outline" : "default"}
            disabled={keepDisabled}
            aria-label={t("review.resolve.keepThis", { name: row.name, number: position + 1 })}
            aria-description={keepDisabled ? t("review.resolve.alreadyKeeper") : undefined}
            onClick={onKeep}
          >
            {keepDisabled
              ? t("review.resolve.kept")
              : kept
                ? t("review.keepOnlyThis")
                : t("review.resolve.keepShort")}
          </Button>
        )}
        {/* The name is the action and names the pair; the reason a disabled one
            cannot run is a description of it, not a replacement for its name. */}
        <Button
          size="sm"
          variant="ghost"
          disabled={compareWith === null}
          aria-label={
            compareWith === null
              ? t("review.compare")
              : t("review.compare.withCopy", { name: row.name, other: compareWith })
          }
          aria-description={compareWith === null ? t("review.compare.noPartner") : undefined}
          onClick={onCompare}
        >
          <FiRepeat className="h-3.5 w-3.5" aria-hidden />
          {t("review.compare")}
        </Button>
      </div>
    </article>
  );
}
