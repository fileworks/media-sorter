/** Inspect one file's metadata, plan, and recorded provenance. */

import { FiArrowLeft, FiArrowRight, FiExternalLink, FiMaximize } from "react-icons/fi";

import { DestinationExplanation } from "@/components/screens/review/DestinationExplanation";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { MediaVideo } from "@/components/ui/media-video";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useMediaInfo, useReviewOutcome } from "@/hooks/useMediaInfo";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { companionRoleLabel, companionStatusLabel, plannedStatusLabel } from "@/lib/evidenceLabels";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { getBasename } from "@/lib/pathUtils";
import { cn } from "@/lib/utils";
import { orderFacts, REVIEW_FACT_LABELS, type ReviewFactId } from "@/lib/reviewFacts";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

interface DetailViewProps {
  row: ReviewRow;
  /** The set this file belongs to, when it is one of several copies. */
  set: SetEntry | null;
  /** Navigation stays within the current duplicate set or folder. */
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

/** One labelled value in the planned-state definition list. */
/** One row of the shared fact list, before the canonical order is applied. */
interface DetailFact {
  id: ReviewFactId;
  value: string;
  unknown?: boolean;
}

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
  const size = formatBytes(row.sizeBytes, { locale, nullPlaceholder: unknown });
  const type = fileType(row.name);

  const outcomeRecord = outcome.data?.state === "available" ? outcome.data.outcome : null;
  // Fall back to endpoint provenance for older preview rows.
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
        {/* Keep the preview and its facts visible together on wide screens. */}
        <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-h-[16rem] overflow-hidden rounded-panel bg-muted sm:min-h-[22rem] lg:min-h-[27rem]">
            {info.data?.media_type === "video" ? (
              <div className="flex h-full min-h-[16rem] items-center justify-center p-3 sm:min-h-[22rem] lg:min-h-[27rem]">
                <MediaVideo path={row.source} name={row.name} className="h-full w-full" />
              </div>
            ) : (
              <Thumbnail
                path={row.source}
                maxPx={1200}
                className="h-full w-full"
                onOpen={onEnlarge}
                openLabel={t("review.viewer.open", { name: row.name })}
              />
            )}
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
              {orderFacts<DetailFact>([
                type === null ? null : { id: "fileType", value: type },
                info.isLoading || infoFailure !== null
                  ? null
                  : { id: "resolution", value: resolution, unknown: resolution === unknown },
                info.data?.media_type === "video"
                  ? {
                      id: "duration",
                      value:
                        info.data.duration_seconds == null
                          ? unknown
                          : `${info.data.duration_seconds.toFixed(1)} s`,
                      unknown: info.data.duration_seconds == null,
                    }
                  : null,
                info.data?.media_type === "video"
                  ? {
                      id: "codec",
                      value: info.data.codec ?? unknown,
                      unknown: info.data.codec == null,
                    }
                  : null,
                { id: "size", value: size, unknown: size === unknown },
                {
                  id: "date",
                  value:
                    row.date === null
                      ? unknown
                      : t("review.detail.dateFrom", {
                          date: row.date,
                          source: formatMetadataSource(row.dateSource, t),
                        }),
                  unknown: row.date === null,
                },
                {
                  id: "source",
                  value: row.folder === "" ? unknown : row.folder,
                  unknown: row.folder === "",
                },
                {
                  id: "destination",
                  value: row.destination ?? t("review.destination.none"),
                  unknown: row.destination === null,
                },
                { id: "result", value: plannedStatusLabel(row.status, t) },
                { id: "reason", value: t(row.reason.key, row.reason.params) },
                { id: "category", value: row.category ?? unknown, unknown: row.category === null },
                {
                  id: "tags",
                  value: row.tags.length > 0 ? row.tags.join(", ") : unknown,
                  unknown: row.tags.length === 0,
                },
                {
                  id: "protection",
                  value: row.protected
                    ? t("review.referenceProtected")
                    : t("review.detail.mutable"),
                },
                row.unitId
                  ? {
                      id: "mediaUnit",
                      value:
                        row.unitPrimary === null
                          ? t("review.detail.mediaUnit.unknown", { id: row.unitId })
                          : t(
                              row.unitPrimary
                                ? "review.detail.mediaUnit.primary"
                                : "review.detail.mediaUnit.member",
                              { id: row.unitId },
                            ),
                      unknown: row.unitPrimary === null,
                    }
                  : null,
                row.companionCount > 0
                  ? {
                      id: "companions",
                      value:
                        row.companions
                          ?.map((companion) =>
                            t("review.detail.companionEvidence", {
                              file: getBasename(companion.source),
                              role: companionRoleLabel(companion.role, t),
                              status: companionStatusLabel(companion.status, t),
                              destination: companion.destination ?? t("review.destination.none"),
                              warning: companion.warning ?? t("review.detail.companionNoWarning"),
                            }),
                          )
                          .join("; ") ?? String(row.companionCount),
                    }
                  : null,
                set === null
                  ? null
                  : {
                      id: "set",
                      value: t("review.detail.setMembership", {
                        count: set.rows.length,
                        kind: t(`review.stack.kind.${set.setKind}`),
                      }),
                    },
              ]).map((fact) => (
                <Fact
                  key={fact.id}
                  label={t(REVIEW_FACT_LABELS[fact.id])}
                  value={fact.value}
                  unknown={fact.unknown}
                />
              ))}
            </dl>
            {row.unitWarnings && row.unitWarnings.length > 0 && (
              <p
                role="alert"
                className="border-t border-warning/30 bg-tint-warning px-2.5 py-2 text-3xs text-warning"
              >
                {row.unitWarnings.join(" ")}
              </p>
            )}
          </aside>
        </div>

        {/* Superseded previews never fabricate provenance. */}
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
        {/* Navigation stays within the current set or folder. */}
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
