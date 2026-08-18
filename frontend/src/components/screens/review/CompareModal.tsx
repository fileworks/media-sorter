/** Compare any two files; keeper actions require a shared duplicate set. */

import { useEffect, useState } from "react";
import { FiCheck, FiChevronLeft, FiChevronRight, FiMaximize } from "react-icons/fi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MediaImage } from "@/components/ui/media-image";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/setting-row";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { getBasename } from "@/lib/pathUtils";
import { cn } from "@/lib/utils";
import { resolutionLabel, type ComparableFile } from "@/lib/reviewWorkbench";
import { api } from "@/services/api";

type Mode = "slide" | "overlay" | "side" | "difference";

interface CompareModalProps {
  a: ComparableFile;
  b: ComparableFile;
  /** Which side the plan currently keeps. */
  keeperId: string | null;
  /** The set both files belong to, or null when they are merely two files. */
  setId: string | null;
  /** A rule suggestion is evidence, never an implicit selection. */
  recommendedId?: string | null;
  recommendedLabel?: string | null;
  recommendationReason?: string | null;
  onKeep: (memberId: string) => void;
  onKeepBoth: () => void;
  onClose: () => void;
  /** Open the full detail view for one side, by its path. */
  onOpenDetail?: (path: string) => void;
  /** Examine one side full screen, by its path. */
  onEnlarge?: (path: string) => void;
  /** Move between comparable duplicate groups without leaving the dialog. */
  onPreviousSet?: (() => void) | null;
  onNextSet?: (() => void) | null;
  /** Cycle every other member of this set against side A. */
  comparisonPosition?: {
    index: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  } | null;
}

/** Identify a fact's winning side with both text and styling. */
function FactRow({
  label,
  left,
  right,
  winner,
  winnerNote,
}: {
  label: string;
  left: string;
  right: string;
  winner: "a" | "b" | null;
  /** Why this side wins, e.g. "larger". Announced, and drawn as a cell note. */
  winnerNote: string;
}) {
  // A neutral difference is evidence, not a winner.
  const differs = winner === null && left !== right;
  const cell = (value: string, side: "a" | "b") => (
    <span
      className={cn(
        "-my-1 min-w-0 break-words rounded-[5px] px-1.5 py-1",
        winner === side
          ? "bg-tint-success font-semibold text-success"
          : differs
            ? "bg-tint-warning text-warning"
            : "text-foreground",
      )}
    >
      {value}
      {winner === side && (
        <>
          <span className="sr-only"> — {winnerNote}</span>
          <span className="mt-0.5 block text-3xs font-bold tracking-[0.02em]" aria-hidden>
            {winnerNote}
          </span>
        </>
      )}
    </span>
  );
  return (
    <div className="grid grid-cols-[5rem_1fr_1fr] items-start gap-2.5 border-b border-border px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[7rem_1fr_1fr]">
      <span className="pt-1 text-faint">{label}</span>
      {cell(left, "a")}
      {cell(right, "b")}
    </div>
  );
}

// Rank confidence so the stronger match can be marked.
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

/** Compare two numbers, tolerating either being unknown. */
function larger(a: number | null, b: number | null): "a" | "b" | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? "a" : "b";
}

function pixels(file: ComparableFile): number | null {
  if (file.facts === null) return null;
  const { width, height } = file.facts;
  if (!width.known || !height.known) return null;
  return Number(width.value) * Number(height.value);
}

function dimensions(file: ComparableFile): { width: number; height: number } | null {
  if (file.facts === null) return null;
  const { width, height } = file.facts;
  if (!width.known || !height.known) return null;
  const values = { width: Number(width.value), height: Number(height.value) };
  return values.width > 0 && values.height > 0 && Object.values(values).every(Number.isFinite)
    ? values
    : null;
}

function pairAspect(a: ComparableFile, b: ComparableFile): number {
  const known = [dimensions(a), dimensions(b)].filter(
    (value): value is { width: number; height: number } => value !== null,
  );
  if (known.length === 0) return 16 / 9;
  return known.reduce((sum, value) => sum + value.width / value.height, 0) / known.length;
}

function factNumber(file: ComparableFile, key: "duration_seconds"): number | null {
  const fact = file.facts?.[key];
  if (!fact?.known) return null;
  const value = Number(fact.value);
  return Number.isFinite(value) ? value : null;
}

function capturedAt(file: ComparableFile): number | null {
  const value = file.facts?.captured_at;
  if (!value || !value.known || typeof value.value !== "string") return null;
  const parsed = Date.parse(value.value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function CompareModal({
  a,
  b,
  keeperId,
  setId,
  recommendedId = null,
  recommendedLabel = null,
  recommendationReason = null,
  onKeep,
  onKeepBoth,
  onClose,
  onOpenDetail,
  onEnlarge,
  onPreviousSet,
  onNextSet,
  comparisonPosition = null,
}: CompareModalProps) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<Mode>("side");
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(100);
  const [draftId, setDraftId] = useState<string | null>(keeperId);

  useEffect(() => {
    setDraftId(keeperId === a.id || keeperId === b.id ? keeperId : null);
    setMode("side");
    setSplit(50);
    setZoom(100);
  }, [a.id, b.id, keeperId]);

  const nameA = getBasename(a.label);
  const nameB = getBasename(b.label);
  const unknown = t("review.detail.unknown");
  const sameSet = setId !== null;
  const aspect = pairAspect(a, b);
  const frameAspect = mode === "side" ? aspect * 2 : aspect;
  const bothVideos = a.facts?.media_kind === "video" && b.facts?.media_kind === "video";
  const resolution = (file: ComparableFile) =>
    dimensions(file) === null ? unknown : resolutionLabel(file.facts!);
  const megapixels = (file: ComparableFile) => {
    const count = pixels(file);
    return count === null
      ? unknown
      : `${(count / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 2 })} MP`;
  };
  const capture = (file: ComparableFile) => {
    const fact = file.facts?.captured_at;
    if (!fact?.known || typeof fact.value !== "string") return unknown;
    return t("review.detail.dateFrom", {
      date: fact.value,
      source:
        file.capturedAtSource === null
          ? t("review.compare.provenanceUnknown")
          : formatMetadataSource(file.capturedAtSource, t),
    });
  };
  const codec = (file: ComparableFile) => {
    const fact = file.facts?.codec;
    return fact?.known && fact.value !== null && fact.value !== undefined
      ? String(fact.value)
      : unknown;
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("review.compare.title")}
      size="xl"
      className="h-[min(52rem,calc(100dvh-2rem))]"
    >
      <ModalHeader>
        <span className="min-w-0 truncate text-xs text-faint">
          {nameA} · {nameB}
        </span>
      </ModalHeader>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-3 py-2">
        <div className="w-full min-w-0 sm:w-auto sm:flex-none [&_label]:px-2 [&_label]:text-[0.7rem] sm:[&_label]:px-3.5 sm:[&_label]:text-2xs">
          <Segmented
            name="compare-mode"
            label={t("review.compare.mode")}
            value={mode}
            options={[
              { value: "side", label: t("review.compare.side") },
              { value: "overlay", label: t("review.compare.overlay") },
              { value: "difference", label: t("review.compare.difference") },
              { value: "slide", label: t("review.compare.slide") },
            ]}
            onChange={setMode}
          />
        </div>
        <span className="w-full min-w-0 text-3xs text-muted-foreground sm:w-auto sm:flex-1">
          {t(`review.compare.hint.${mode}`)}
        </span>
        <label className="flex w-full items-center gap-2 text-3xs text-muted-foreground sm:ml-auto sm:w-auto">
          {t("review.compare.zoom")}
          <input
            type="range"
            min={100}
            max={200}
            step={5}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-24 sm:w-36"
          />
          <output className="w-10 text-right font-mono text-3xs tabular-nums">{zoom}%</output>
        </label>
      </div>

      <ModalBody className="px-0 py-0">
        <div className="flex h-[clamp(13rem,38dvh,25rem)] items-center justify-center overflow-hidden bg-background px-2 py-2 sm:px-4">
          <div
            className="relative max-h-full max-w-full overflow-hidden bg-background"
            data-testid="comparison-frame"
            data-aspect-ratio={frameAspect.toFixed(4)}
            style={{
              aspectRatio: frameAspect,
              width: `min(100%, calc(clamp(13rem, 38dvh, 25rem) * ${frameAspect}))`,
              transform: `scale(${zoom / 100})`,
              transition: "transform 160ms ease",
            }}
          >
            {mode === "difference" ? (
              <MediaImage
                src={api.diffUrl(a.path, b.path, 800)}
                alt={t("review.compare.diffAlt", { a: nameA, b: nameB })}
                className="h-full w-full object-contain"
                fallback={
                  <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                    {t("review.compare.diffUnavailable")}
                  </p>
                }
              />
            ) : mode === "side" ? (
              <div className="grid h-full grid-cols-2 gap-px bg-border">
                {([a, b] as const).map((file) => (
                  <div
                    key={file.id}
                    className={cn(
                      "relative h-full w-full overflow-hidden",
                      // An inset ring preserves alignment between the two images.
                      recommendedId === file.id &&
                        "shadow-[inset_0_0_0_2px_hsl(var(--color-success))]",
                    )}
                  >
                    <Thumbnail path={file.path} maxPx={800} className="h-full w-full" />
                  </div>
                ))}
              </div>
            ) : mode === "overlay" ? (
              <>
                <Thumbnail path={a.path} maxPx={800} className="absolute inset-0 h-full w-full" />
                <div
                  className="absolute inset-0 transition-opacity duration-150"
                  style={{ opacity: split / 100 }}
                >
                  <Thumbnail path={b.path} maxPx={800} className="h-full w-full" />
                </div>
                <label className="absolute inset-x-0 bottom-3 px-6">
                  <span className="sr-only">{t("review.compare.overlayLabel")}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    onChange={(event) => setSplit(Number(event.target.value))}
                    className="w-full"
                  />
                </label>
              </>
            ) : (
              <>
                <Thumbnail path={b.path} maxPx={800} className="absolute inset-0 h-full w-full" />
                {/* Clip at a shared scale so the slider compares matching pixels. */}
                <div
                  className="absolute inset-0"
                  style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                >
                  <Thumbnail path={a.path} maxPx={800} className="absolute inset-0 h-full w-full" />
                </div>
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-brand"
                  style={{ left: `${split}%` }}
                  aria-hidden
                />
                <label className="absolute inset-x-0 bottom-3 px-6">
                  <span className="sr-only">{t("review.compare.splitLabel")}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    onChange={(event) => setSplit(Number(event.target.value))}
                    className="w-full"
                  />
                </label>
              </>
            )}

            <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-foreground/80 px-2.5 py-0.5 text-3xs font-bold text-background">
              {t("review.compare.sideA", { state: draftId === a.id ? "•" : "" })}
            </span>
            <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-foreground/80 px-2.5 py-0.5 text-3xs font-bold text-background">
              {t("review.compare.sideB", { state: draftId === b.id ? "•" : "" })}
            </span>
          </div>
        </div>

        {/* Keep captions outside the zoomed media frame. */}
        <div className="grid grid-cols-2 gap-2 bg-background px-2 pb-2 sm:px-4">
          {([a, b] as const).map((file, index) => (
            <div
              key={file.id}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-panel border bg-card px-2.5 py-2",
                recommendedId === file.id
                  ? "border-success/60 shadow-[inset_0_0_0_1px_hsl(var(--color-success)/0.25)]"
                  : "border-border",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-foreground">
                    {index === 0 ? nameA : nameB}
                  </span>
                  {recommendedId === file.id && (
                    <Badge tone="success">{t("review.resolve.recommendation")}</Badge>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                  {file.facts ? formatBytes(file.facts.size_bytes, { locale }) : unknown} ·{" "}
                  {resolution(file)}
                </span>
              </span>
              {onEnlarge && (
                <button
                  type="button"
                  onClick={() => onEnlarge(file.path)}
                  aria-label={t("review.viewer.open", { name: getBasename(file.label) })}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FiMaximize className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-2.5 border-y border-border bg-card px-3 py-3">
          <div className="flex min-w-0 gap-2 rounded-panel border border-success/35 bg-tint-success px-2.5 py-2">
            <FiCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <div className="min-w-0">
              <strong className="block text-xs text-foreground">
                {recommendedLabel === null
                  ? t("review.compare.recommendation")
                  : t("review.resolve.recommended", { name: recommendedLabel })}
              </strong>
              <p className="mt-0.5 text-3xs leading-relaxed text-muted-foreground">
                {recommendedLabel === null
                  ? t("review.compare.recommendationNone")
                  : (recommendationReason ?? recommendedLabel)}
              </p>
            </div>
          </div>
          {sameSet && (
            <fieldset>
              <legend className="mb-1.5 text-3xs font-semibold text-muted-foreground">
                {t("review.compare.selectToKeep")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([a, b] as const).map((file, index) => {
                  const selected = draftId === file.id;
                  const recommended = recommendedId === file.id;
                  return (
                    <button
                      key={file.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setDraftId(file.id)}
                      className={cn(
                        "flex min-h-10 min-w-0 items-center justify-between gap-2 rounded-control border px-2.5 py-1.5 text-left",
                        "transition-[border-color,background-color,box-shadow]",
                        selected
                          ? "border-primary bg-tint-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]"
                          : recommended
                            ? "border-dashed border-success bg-tint-success/40"
                            : "border-border hover:border-border-strong hover:bg-muted/50",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-foreground">
                          {index === 0 ? "A" : "B"} · {getBasename(file.label)}
                        </span>
                        {/* State the selection independently of border color. */}
                        <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                          {selected
                            ? t("review.compare.willBeKept")
                            : t("review.compare.notSelected")}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          "grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border text-3xs",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border-strong",
                        )}
                      >
                        {selected && <FiCheck className="h-3 w-3" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>

        <div className="border-b border-border bg-card px-3 py-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t("review.compare.detailsTitle")}
          </h3>
          <p className="mt-0.5 text-3xs text-muted-foreground">{t("review.compare.detailsHelp")}</p>
        </div>
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-2.5 border-b border-border bg-muted/40 px-3 py-2 text-3xs font-semibold uppercase tracking-[0.07em] text-faint sm:grid-cols-[7rem_1fr_1fr]">
          <span />
          {/* Column headings link to each file's full details. */}
          {(
            [
              [t("review.compare.columnA", { name: nameA }), a],
              [t("review.compare.columnB", { name: nameB }), b],
            ] as const
          ).map(([label, file]) => (
            <span key={file.id} className="flex min-w-0 items-center gap-1.5">
              {onOpenDetail ? (
                <button
                  type="button"
                  onClick={() => onOpenDetail(file.path)}
                  className="truncate text-left uppercase tracking-[0.07em] underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {label}
                </button>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </span>
          ))}
        </div>
        <FactRow
          label={t("review.column.date")}
          left={capture(a)}
          right={capture(b)}
          winner={larger(capturedAt(a), capturedAt(b))}
          winnerNote={t("review.compare.wins.newer")}
        />
        <FactRow
          label={t("review.column.resolution")}
          left={resolution(a)}
          right={resolution(b)}
          winner={larger(pixels(a), pixels(b))}
          winnerNote={t("review.compare.wins.moreDetail")}
        />
        <FactRow
          label={t("review.column.megapixels")}
          left={megapixels(a)}
          right={megapixels(b)}
          winner={larger(pixels(a), pixels(b))}
          winnerNote={t("review.compare.wins.moreDetail")}
        />
        <FactRow
          label={t("review.column.size")}
          left={a.facts ? formatBytes(a.facts.size_bytes, { locale }) : unknown}
          right={b.facts ? formatBytes(b.facts.size_bytes, { locale }) : unknown}
          winnerNote={t("review.compare.wins.larger")}
          winner={larger(a.facts?.size_bytes ?? null, b.facts?.size_bytes ?? null)}
        />
        <FactRow
          label={t("review.column.location")}
          left={a.label}
          right={b.label}
          winner={null}
          winnerNote=""
        />
        <FactRow
          label={t("review.column.evidence")}
          left={a.confidence === null ? unknown : t(`review.confidenceValue.${a.confidence}`)}
          right={b.confidence === null ? unknown : t(`review.confidenceValue.${b.confidence}`)}
          winner={larger(
            a.confidence === null ? null : (CONFIDENCE_RANK[a.confidence] ?? null),
            b.confidence === null ? null : (CONFIDENCE_RANK[b.confidence] ?? null),
          )}
          winnerNote={t("review.compare.wins.stronger")}
        />
        {bothVideos && (
          <>
            <FactRow
              label={t("review.column.duration")}
              left={formatDuration(factNumber(a, "duration_seconds"), {
                locale,
                nullPlaceholder: unknown,
              })}
              right={formatDuration(factNumber(b, "duration_seconds"), {
                locale,
                nullPlaceholder: unknown,
              })}
              winner={larger(factNumber(a, "duration_seconds"), factNumber(b, "duration_seconds"))}
              winnerNote={t("review.compare.wins.longer")}
            />
            <FactRow
              label={t("review.column.codec")}
              left={codec(a)}
              right={codec(b)}
              winner={null}
              winnerNote=""
            />
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <span className="mr-auto min-w-0 text-3xs text-faint">
          {sameSet ? (
            <>
              <span className="block" aria-live="polite">
                {draftId === null
                  ? t("review.compare.nothingSelected")
                  : t("review.compare.selectionState", {
                      name: getBasename((draftId === a.id ? a : b).label),
                    })}
              </span>
              <span className="block">{t("review.compare.scopeNote")}</span>
            </>
          ) : (
            t("review.compare.notOneSet")
          )}
        </span>
        {comparisonPosition && (
          <div className="flex items-center gap-1 border-r border-border pr-2">
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("review.compare.previousCopy")}
              onClick={comparisonPosition.onPrevious}
            >
              <FiChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
              {t("review.compare.copyPosition", {
                index: comparisonPosition.index + 1,
                total: comparisonPosition.total,
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("review.compare.nextCopy")}
              onClick={comparisonPosition.onNext}
            >
              <FiChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
        {(onPreviousSet || onNextSet) && (
          <div className="flex items-center gap-1 sm:border-r sm:border-border sm:pr-2">
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("review.compare.previousSet")}
              onClick={onPreviousSet ?? undefined}
              disabled={!onPreviousSet}
            >
              <FiChevronLeft className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{t("review.compare.previousSet")}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("review.compare.nextSet")}
              onClick={onNextSet ?? undefined}
              disabled={!onNextSet}
            >
              <span className="hidden sm:inline">{t("review.compare.nextSet")}</span>
              <FiChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("review.compare.back")}
        </Button>
        {sameSet && (
          <>
            <Button size="sm" variant="outline" onClick={onKeepBoth}>
              {t("review.compare.keepBoth")}
            </Button>
            <Button
              size="sm"
              disabled={draftId === null}
              onClick={() => draftId && onKeep(draftId)}
            >
              {t("review.compare.confirmSelection")}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
