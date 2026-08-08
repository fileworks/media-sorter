/**
 * Two copies, side by side, so the choice is made by looking rather than by
 * reading numbers.
 *
 * Three modes because three different questions get asked: Slide answers "is
 * this the same picture", Side-by-side answers "which one is framed better",
 * Difference answers "did anything actually change". The facts table underneath
 * marks which side wins each individual comparison, which is the part people
 * actually decide on when the images look identical.
 *
 * **Any two files can be compared.** Selecting two that were not in the same
 * duplicate set used to open nothing at all — the caller returned early and the
 * button appeared broken. Two pictures can always be put side by side; what
 * needs them to share a set is only whether a *keeper* can be chosen here, and
 * that is now stated in the footer instead of enforced by silence.
 */

import { useState } from "react";
import { FiMaximize } from "react-icons/fi";

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

type Mode = "slide" | "side" | "difference";

interface CompareModalProps {
  a: ComparableFile;
  b: ComparableFile;
  /** Which side the plan currently keeps. */
  keeperId: string | null;
  /** The set both files belong to, or null when they are merely two files. */
  setId: string | null;
  onKeep: (memberId: string) => void;
  onKeepBoth: () => void;
  onClose: () => void;
  /** Open the full detail view for one side, by its path. */
  onOpenDetail?: (path: string) => void;
  /** Examine one side full screen, by its path. */
  onEnlarge?: (path: string) => void;
}

/**
 * One comparison row, with the winning side marked.
 *
 * Marked three ways, not one: weight, colour and a word only a screen reader
 * reads. Colour alone would leave the whole table meaningless to anyone who
 * cannot see it, and this table is what the choice is actually made on when the
 * two images look identical.
 */
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
  /** Why this side wins, e.g. "larger". Announced, never drawn. */
  winnerNote: string;
}) {
  const cell = (value: string, side: "a" | "b") => (
    <span
      className={cn(
        "break-words",
        winner === side ? "font-semibold text-success" : "text-foreground",
      )}
    >
      {value}
      {winner === side && <span className="sr-only"> — {winnerNote}</span>}
    </span>
  );
  return (
    <div className="grid grid-cols-[5rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-xs last:border-b-0 sm:grid-cols-[7rem_1fr_1fr]">
      <span className="text-faint">{label}</span>
      {cell(left, "a")}
      {cell(right, "b")}
    </div>
  );
}

//: How much a match is worth, ordered, so the stronger evidence can be marked.
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
  onKeep,
  onKeepBoth,
  onClose,
  onOpenDetail,
  onEnlarge,
}: CompareModalProps) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<Mode>("slide");
  const [split, setSplit] = useState(50);

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
    <Modal open onClose={onClose} title={t("review.compare.title")} size="full">
      <ModalHeader
        actions={
          <Segmented
            name="compare-mode"
            label={t("review.compare.mode")}
            value={mode}
            options={[
              { value: "slide", label: t("review.compare.slide") },
              { value: "side", label: t("review.compare.side") },
              { value: "difference", label: t("review.compare.difference") },
            ]}
            onChange={setMode}
          />
        }
      >
        <span className="min-w-0 truncate text-xs text-faint">
          {nameA} · {nameB}
        </span>
      </ModalHeader>

      <div className="flex h-[clamp(16rem,56dvh,52rem)] shrink-0 items-center justify-center overflow-hidden bg-background px-2 py-2 sm:px-4">
        <div
          className="relative max-h-full max-w-full overflow-hidden bg-background"
          data-testid="comparison-frame"
          data-aspect-ratio={frameAspect.toFixed(4)}
          style={{
            aspectRatio: frameAspect,
            width: `min(100%, calc(clamp(16rem, 56dvh, 52rem) * ${frameAspect}))`,
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
              <Thumbnail path={a.path} maxPx={800} className="h-full w-full" />
              <Thumbnail path={b.path} maxPx={800} className="h-full w-full" />
            </div>
          ) : (
            <>
              <Thumbnail path={b.path} maxPx={800} className="absolute inset-0 h-full w-full" />
              {/* Clipping rather than resizing: both images stay laid out at the
                full panel width, so the slider reveals the same pixels the
                other side is showing instead of a differently-scaled copy. */}
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

          <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-success px-2.5 py-0.5 text-3xs font-bold text-white">
            {t("review.compare.sideA", { state: keeperId === a.id ? "•" : "" })}
          </span>
          <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-muted px-2.5 py-0.5 text-3xs font-bold text-muted-foreground">
            {t("review.compare.sideB", { state: keeperId === b.id ? "•" : "" })}
          </span>
        </div>
      </div>

      <ModalBody className="px-0 py-0">
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-3xs font-semibold uppercase tracking-[0.07em] text-faint sm:grid-cols-[7rem_1fr_1fr]">
          <span />
          {/* The column heads are the way into the full facts for either side:
              a comparison that raises a question about one file should not make
              the user close it to answer that question. */}
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
              {/* Two files that look identical at this size are exactly the case
                  where the decision needs them at full size. */}
              {onEnlarge && (
                <button
                  type="button"
                  onClick={() => onEnlarge(file.path)}
                  aria-label={t("review.viewer.open", { name: getBasename(file.label) })}
                  className="shrink-0 rounded p-0.5 text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FiMaximize className="h-3 w-3" aria-hidden />
                </button>
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
        {/* Two files that are not one set can still be looked at side by side —
            there is simply nothing to keep *instead of* the other, and saying so
            is better than three buttons that would decide the wrong thing. */}
        <span className="mr-auto min-w-0 text-xs text-faint">
          {sameSet ? t("review.compare.scopeNote") : t("review.compare.notOneSet")}
        </span>
        {sameSet && (
          <>
            <Button size="sm" variant="outline" onClick={onKeepBoth}>
              {t("review.compare.keepBoth")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onKeep(b.id)}>
              {t("review.compare.keepB")}
            </Button>
            <Button size="sm" onClick={() => onKeep(a.id)}>
              {t("review.compare.keepA")}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
