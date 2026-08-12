/**
 * Everything known about one file, including how it came to be known.
 *
 * The inspector was removed as unreferenced, which left `/api/media/info` and
 * `POST /api/review/outcomes` working with no callers — and left the screen
 * unable to answer "what *is* this file?" at all. It is back, and it now shows
 * the thing only the outcomes endpoint knows: which candidate dates existed,
 * which one won, and why each of the others lost. A row's reason summarises
 * that in a sentence; this is the working.
 *
 * A fact that is not known says so. Nothing here fabricates a zero, a date or a
 * resolution — the file being inspected is one somebody is about to make a
 * decision about, and a plausible-looking wrong number is worse than a gap.
 */

import { FiArrowLeft, FiArrowRight, FiExternalLink, FiMaximize } from "react-icons/fi";

import { DestinationExplanation } from "@/components/screens/review/DestinationExplanation";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useMediaInfo, useReviewOutcome } from "@/hooks/useMediaInfo";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { cn } from "@/lib/utils";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

interface DetailViewProps {
  row: ReviewRow;
  /** The set this file belongs to, when it is one of several copies. */
  set: SetEntry | null;
  /**
   * What left and right are walking, and where in it this file sits.
   *
   * A file outside a duplicate set walks the folder it was opened from. Both
   * halves were always required; only the set half was ever wired, so for most
   * files the arrows sat inert beside "not part of a duplicate set" — which
   * reads as a fault rather than as a boundary.
   */
  scope: { kind: "set" | "folder"; index: number; total: number };
  /** Where left and right go. Null at either end of the scope. */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onEnlarge: () => void;
  onKeepThis: (() => void) | null;
  onOpenInResolve: (() => void) | null;
  /** Open Configure at the setting that produced an attributed segment. */
  onOpenSetting: (anchorId: string) => void;
  /** Rebuild provenance when the plan that recorded it has been superseded. */
  onRerunPreview: () => void;
  onClose: () => void;
}

/**
 * One line of the planned-state card.
 *
 * A definition list, not a table of rows: these are labelled values about one
 * subject, and marking them up as such is what lets a screen reader read
 * "Goes to — 2024/07/IMG_2048.heic" instead of two unrelated cells.
 */
function Fact({ label, value, unknown }: { label: string; value: string; unknown?: boolean }) {
  return (
    <>
      <dt className="text-3xs text-faint">{label}</dt>
      <dd
        className={cn(
          "m-0 min-w-0 break-words text-3xs",
          unknown ? "text-faint" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </>
  );
}

/** The extension as a person would name the format, or nothing to show. */
function fileType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toUpperCase();
}

export function DetailView({
  row,
  set,
  scope,
  onPrevious,
  onNext,
  onEnlarge,
  onKeepThis,
  onOpenInResolve,
  onOpenSetting,
  onRerunPreview,
  onClose,
}: DetailViewProps) {
  const { t, locale } = useI18n();
  const info = useMediaInfo(row.source);
  const outcome = useReviewOutcome(row.source);

  const infoFailure = info.isError
    ? extractErrorMessage(info.error, t("review.detail.infoFailed"))
    : null;
  const outcomeFailure = outcome.isError
    ? extractErrorMessage(outcome.error, t("review.detail.provenanceFailed"))
    : null;

  const unknown = t("review.detail.unknown");
  const resolution =
    info.data?.width != null && info.data?.height != null
      ? `${info.data.width} × ${info.data.height}`
      : unknown;
  const size = row.sizeBytes > 0 ? formatBytes(row.sizeBytes, { locale }) : unknown;
  const type = fileType(row.name);

  const outcomeRecord = outcome.data?.state === "available" ? outcome.data.outcome : null;
  // The row and the inspector prefer the exact same plan object. The endpoint
  // validates that it is still current and supplies a compatibility fallback
  // for plans created before rows began carrying provenance directly.
  const provenance =
    outcome.data?.state === "available"
      ? (row.provenance ?? outcomeRecord?.provenance ?? null)
      : null;

  return (
    <Modal open onClose={onClose} title={row.name} size="xl">
      <ModalHeader>
        <span className="min-w-0 truncate text-xs text-faint" title={row.source}>
          {row.source}
        </span>
      </ModalHeader>

      <ModalBody className="p-0">
        {/* The picture gets the room, and the facts about it sit beside it
            rather than under it — a preview whose metadata is a scroll away is
            one the reader has to remember instead of read. */}
        <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-h-[16rem] overflow-hidden rounded-panel bg-muted sm:min-h-[22rem] lg:min-h-[27rem]">
            <Thumbnail
              path={row.source}
              maxPx={1200}
              className="h-full w-full"
              onOpen={onEnlarge}
              openLabel={t("review.viewer.open", { name: row.name })}
            />
          </div>

          <aside className="self-start overflow-hidden rounded-panel border border-border">
            <h3 className="border-b border-border px-2.5 py-2 text-xs font-semibold text-foreground">
              {t("review.detail.plannedState")}
            </h3>
            {info.isLoading ? (
              <StateView
                compact
                variant="loading"
                title={t("review.detail.infoLoading")}
                className="m-2.5"
              />
            ) : infoFailure !== null ? (
              <StateView
                compact
                variant="error"
                title={infoFailure.message}
                code={infoFailure.code}
                onRetry={() => void info.refetch()}
                className="m-2.5"
              />
            ) : null}
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2.5 gap-y-2 px-2.5 py-2.5">
              {type !== null && <Fact label={t("review.detail.fileType")} value={type} />}
              {!info.isLoading && infoFailure === null && (
                <Fact
                  label={t("review.column.resolution")}
                  value={resolution}
                  unknown={resolution === unknown}
                />
              )}
              <Fact label={t("review.column.size")} value={size} unknown={size === unknown} />
              <Fact
                label={t("review.column.date")}
                value={
                  row.date === null
                    ? unknown
                    : t("review.detail.dateFrom", {
                        date: row.date,
                        source: formatMetadataSource(row.dateSource, t),
                      })
                }
                unknown={row.date === null}
              />
              <Fact
                label={t("review.detail.source")}
                value={row.folder === "" ? unknown : row.folder}
                unknown={row.folder === ""}
              />
              <Fact
                label={t("review.detail.destination")}
                value={row.destination ?? t("review.destination.none")}
                unknown={row.destination === null}
              />
              <Fact
                label={t("review.detail.reason")}
                value={t(row.reason.key, row.reason.params)}
              />
              <Fact
                label={t("review.detail.category")}
                value={row.category ?? unknown}
                unknown={row.category === null}
              />
              <Fact
                label={t("review.detail.tags")}
                value={row.tags.length > 0 ? row.tags.join(", ") : unknown}
                unknown={row.tags.length === 0}
              />
              {set !== null && (
                <Fact
                  label={t("review.detail.set")}
                  value={t("review.detail.setMembership", {
                    count: set.rows.length,
                    kind: t(`review.stack.kind.${set.setKind}`),
                  })}
                />
              )}
            </dl>
          </aside>
        </div>

        {/* The working behind the complete destination. Absent rather than
            invented when the preview that recorded it has been superseded. */}
        <div className="border-t border-border px-3 py-3">
          {outcome.isLoading ? (
            <StateView
              compact
              variant="loading"
              title={t("review.detail.provenanceLoading")}
              className="mt-2"
            />
          ) : outcome.data?.state === "superseded" ? (
            <StateView
              compact
              variant="blocked"
              title={t("review.detail.provenanceSuperseded")}
              action={
                <Button size="sm" onClick={onRerunPreview}>
                  {t("review.detail.rebuildExplanation")}
                </Button>
              }
              className="mt-2"
            />
          ) : outcomeFailure !== null ? (
            <StateView
              compact
              variant="error"
              title={outcomeFailure.message}
              code={outcomeFailure.code}
              onRetry={() => void outcome.refetch()}
              className="mt-2"
            />
          ) : provenance === null ? (
            <p className="mt-1.5 text-xs text-faint">{t("review.detail.provenanceUnavailable")}</p>
          ) : (
            <DestinationExplanation provenance={provenance} onOpenSetting={onOpenSetting} />
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        {/* Left and right stay inside whatever the reader is reading — the
            copies of one set, or the folder they opened this from. Walking off
            into the rest of the plan would lose the comparison they came for. */}
        <div className="mr-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={onPrevious === null}
            onClick={() => onPrevious?.()}
            aria-label={t("review.detail.previous")}
            aria-description={onPrevious === null ? t("review.detail.noPrevious") : undefined}
          >
            <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={onNext === null}
            onClick={() => onNext?.()}
            aria-label={t("review.detail.next")}
            aria-description={onNext === null ? t("review.detail.noNext") : undefined}
          >
            <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <span className="text-3xs text-faint">
            {scope.total <= 1
              ? t("review.detail.onlyOne")
              : t(scope.kind === "set" ? "review.detail.withinSet" : "review.detail.withinFolder", {
                  index: scope.index + 1,
                  total: scope.total,
                })}
          </span>
        </div>

        <Button size="sm" variant="outline" onClick={onEnlarge}>
          <FiMaximize className="h-3.5 w-3.5" aria-hidden />
          {t("review.viewer.enlarge")}
        </Button>

        {onOpenInResolve !== null && (
          <Button size="sm" variant="outline" onClick={onOpenInResolve}>
            <FiExternalLink className="h-3.5 w-3.5" aria-hidden />
            {t("review.browse.openInResolve")}
          </Button>
        )}
        {onKeepThis !== null && (
          <Button size="sm" onClick={onKeepThis}>
            {t("review.detail.makeKeeper")}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
