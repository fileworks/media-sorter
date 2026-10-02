/** Compare any two files; keeper actions require a shared duplicate set. */

import { useEffect, useState } from "react";
import { FiCheck, FiChevronLeft, FiChevronRight, FiInfo, FiMaximize } from "react-icons/fi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MediaImage } from "@/components/ui/media-image";
import { Modal, ModalBody, ModalFooter, ModalHeader, ModalShortcuts } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/setting-row";
import { Tooltip } from "@/components/ui/tooltip";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { companionRoleLabel, companionStatusLabel, plannedStatusLabel } from "@/lib/evidenceLabels";
import { orderFacts, REVIEW_FACT_LABELS, type ReviewFactId } from "@/lib/reviewFacts";
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
  /** Full set size; the visible pair may be only two members of a larger set. */
  setMemberCount?: number;
  /** A rule suggestion is evidence, never an implicit selection. */
  recommendedId?: string | null;
  recommendedLabel?: string | null;
  recommendationReason?: string | null;
  /** Reference-root sets can be inspected here but never re-decided. */
  decisionLocked?: boolean;
  onKeep: (memberId: string) => void;
  onKeepBoth: () => void;
  onClose: () => void;
  saving?: boolean;
  saveError?: string | null;
  onRetrySave?: () => void;
  /** Open the full detail view for one side, by its path. */
  onOpenDetail?: (path: string) => void;
  /** Examine one side full screen, by its path. */
  onEnlarge?: (path: string) => void;
  /** Move between comparable duplicate groups without leaving the dialog. */
  onPreviousSet?: (() => void) | null;
  onNextSet?: (() => void) | null;
  /**
   * What each side is called *within its set* — A, B, C — not which side of the
   * screen it is on.
   *
   * A pair is two of possibly many, so "A" has to name a copy rather than a
   * position; otherwise stepping to the next pair renames both sides under the
   * reader. Two copies degenerate to the familiar A and B.
   */
  letterA?: string;
  letterB?: string;
  /**
   * Step through every unordered pair of the set's copies.
   *
   * Not "every other member against side A": in a set of three that never puts
   * the second copy beside the third, which is the comparison a person reaches
   * for the moment they have ruled the first one out.
   *
   * `pairs` is the whole matrix, so past two copies the reader can go straight
   * to the comparison they want instead of stepping around a ring guessing
   * which two are coming next.
   */
  comparisonPosition?: {
    index: number;
    total: number;
    pairs: readonly { index: number; a: string; b: string; nameA: string; nameB: string }[];
    onPrevious: () => void;
    onNext: () => void;
    onSelect: (index: number) => void;
  } | null;
}

/** Identify a fact's winning side with both text and styling. */
/** One comparison row, before the shared order is applied. */
interface CompareFact {
  id: ReviewFactId;
  left: string;
  right: string;
  winner?: "a" | "b" | null;
  /** Why this side wins. Omitted where neither side can win. */
  winnerNote?: string;
}

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
  // `py-1` and no negative margin, matching the label beside it: the cells
  // used to pull themselves 4px upward while the label pushed itself 4px down,
  // so the value and the thing it was labelled by sat on different lines.
  const cell = (value: string, side: "a" | "b") => (
    <span
      className={cn(
        "min-w-0 break-words rounded-control px-2 py-1",
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
    <div className="grid grid-cols-[5rem_1fr_1fr] items-start gap-3 border-b border-border px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[7rem_1fr_1fr]">
      <span data-testid="fact-row-label" className="px-0 py-1 text-faint">
        {label}
      </span>
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
  setMemberCount = 2,
  recommendedId = null,
  recommendedLabel = null,
  recommendationReason = null,
  decisionLocked = false,
  onKeep,
  onKeepBoth,
  onClose,
  saving = false,
  saveError = null,
  onRetrySave,
  onOpenDetail,
  onEnlarge,
  onPreviousSet,
  onNextSet,
  letterA = "A",
  letterB = "B",
  comparisonPosition = null,
}: CompareModalProps) {
  const { t, locale } = useI18n();
  const slowSave = useDelayedFlag(saving);
  const [mode, setMode] = useState<Mode>("side");
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(100);
  const [draftId, setDraftId] = useState<string | null>(keeperId);

  // Only the draft keeper is about *these two files*. How you are looking at
  // them — side by side, difference, the slider position, the zoom — is a way
  // of working, and resetting it on every pair meant a reader comparing four
  // copies in difference mode re-picked difference mode five times.
  useEffect(() => {
    setDraftId(keeperId === a.id || keeperId === b.id ? keeperId : null);
  }, [a.id, b.id, keeperId]);

  const nameA = getBasename(a.label);
  const nameB = getBasename(b.label);
  const unknown = t("review.detail.unknown");
  const sameSet = setId !== null;
  const decisionEnabled = sameSet && !decisionLocked;
  const aspect = pairAspect(a, b);
  const frameAspect = mode === "side" ? aspect * 2 : aspect;
  const kindA = a.facts?.media_kind ?? "unknown";
  const kindB = b.facts?.media_kind ?? "unknown";
  const bothVideos = kindA === "video" && kindB === "video";
  const eitherVideo = kindA === "video" || kindB === "video";
  const mediaKind = (file: ComparableFile) => {
    const kind = file.facts?.media_kind;
    return kind && kind !== "unknown" ? t(`review.mediaKind.${kind}`) : unknown;
  };
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
    if (file.facts?.media_kind === "unknown" || file.facts === null) return unknown;
    if (file.facts.media_kind !== "video") return t("review.compare.notApplicable");
    const fact = file.facts?.codec;
    return fact?.known && fact.value !== null && fact.value !== undefined
      ? String(fact.value)
      : unknown;
  };
  const duration = (file: ComparableFile) => {
    if (file.facts?.media_kind === "unknown" || file.facts === null) return unknown;
    if (file.facts.media_kind !== "video") return t("review.compare.notApplicable");
    return formatDuration(factNumber(file, "duration_seconds"), {
      locale,
      nullPlaceholder: unknown,
    });
  };
  const unit = (file: ComparableFile) => {
    if (file.unitId === undefined) return unknown;
    if (file.unitId === null) return t("review.compare.unit.standalone");
    if (file.unitPrimary === null || file.unitPrimary === undefined) return unknown;
    return t(file.unitPrimary ? "review.compare.unit.primary" : "review.compare.unit.member", {
      id: file.unitId,
    });
  };
  const companionEvidence = (file: ComparableFile) => {
    if (file.companions === undefined) return unknown;
    if (file.companions.length === 0) return t("review.compare.companions.none");
    return file.companions
      .map((companion) =>
        t("review.compare.companions.entry", {
          role: companionRoleLabel(companion.role, t),
          status: companionStatusLabel(companion.status, t),
          destination: companion.destination ?? unknown,
          warning: companion.warning ?? t("review.compare.companions.noWarning"),
        }),
      )
      .join("; ");
  };
  const warnings = (file: ComparableFile) => {
    if (file.unitWarnings === undefined) return unknown;
    return file.unitWarnings.length > 0
      ? file.unitWarnings.join(" ")
      : t("review.compare.unitWarnings.none");
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("review.compare.title")}
      size="xl"
      className="h-[min(52rem,calc(100dvh-2rem))]"
    >
      {/* The same two keys every other dialog here answers, and only while
          this one is on top: enlarging a side opens the viewer above it. */}
      <ModalShortcuts
        onKey={(event) => {
          if (comparisonPosition === null) return;
          if (event.key === "ArrowLeft") comparisonPosition.onPrevious();
          else if (event.key === "ArrowRight") comparisonPosition.onNext();
        }}
      />
      <ModalHeader>
        <span className="min-w-0 truncate text-xs text-faint">
          {letterA} {nameA} · {letterB} {nameB}
        </span>
      </ModalHeader>

      {/* Every pairing, laid out, with the one on screen marked.
          A set of four copies is six comparisons, and a ring you step around
          shows you a position — "4 of 6" — while hiding the only thing worth
          knowing, which is which two you are looking at and which two you have
          not reached. Each chip names its pair by the letters the copies keep
          for as long as the set is open. */}
      {comparisonPosition !== null && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
          <span
            id="review-compare-pairs"
            className="shrink-0 text-3xs font-semibold uppercase tracking-[0.07em] text-faint"
          >
            {t("review.compare.pairs")}
          </span>
          <div
            role="group"
            aria-labelledby="review-compare-pairs"
            className="flex min-w-0 flex-wrap items-center gap-1"
          >
            {comparisonPosition.pairs.map((pair) => {
              const current = pair.index === comparisonPosition.index;
              return (
                <button
                  key={pair.index}
                  type="button"
                  aria-current={current ? "true" : undefined}
                  aria-label={t("review.compare.selectPair", {
                    a: getBasename(pair.nameA),
                    b: getBasename(pair.nameB),
                  })}
                  onClick={() => comparisonPosition.onSelect(pair.index)}
                  className={cn(
                    "inline-flex min-h-6 items-center rounded-control border px-2 font-mono text-3xs font-semibold tabular-nums transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    current
                      ? "border-primary bg-tint-primary text-primary"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t("review.compare.pair", { a: pair.a, b: pair.b })}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-3 py-2">
        <div className="w-full min-w-0 sm:w-auto sm:flex-none [&_label]:px-2 [&_label]:text-[0.7rem] sm:[&_label]:px-4 sm:[&_label]:text-2xs">
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
            className="h-6 w-24 cursor-pointer sm:w-36"
          />
          <output className="w-10 text-right font-mono text-3xs tabular-nums">{zoom}%</output>
        </label>
      </div>

      <ModalBody className="px-0 py-0">
        <div className="flex h-[clamp(13rem,44dvh,30rem)] items-center justify-center overflow-hidden bg-background px-2 py-2 sm:px-4">
          <div
            className="relative max-h-full max-w-full overflow-hidden bg-background"
            data-testid="comparison-frame"
            data-aspect-ratio={frameAspect.toFixed(4)}
            style={{
              aspectRatio: frameAspect,
              width: `min(100%, calc(clamp(13rem, 44dvh, 30rem) * ${frameAspect}))`,
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
                        "shadow-[inset_0_0_0_2px_hsl(var(--color-suggest))]",
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

            <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-foreground/80 px-3 py-0.5 text-3xs font-bold text-background">
              {t("review.compare.sideBadge", {
                letter: letterA,
                state: draftId === a.id ? "•" : "",
              })}
            </span>
            <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-foreground/80 px-3 py-0.5 text-3xs font-bold text-background">
              {t("review.compare.sideBadge", {
                letter: letterB,
                state: draftId === b.id ? "•" : "",
              })}
            </span>
          </div>
        </div>

        {/* One block per side, and one block only.
            The captions, the keeper radios and the recommendation card each
            used to name both files, so a two-file comparison printed six
            filenames and three states across three stacked rows before the
            facts table began. They are one row now: the card is the caption,
            the radio, the recommendation marker and the way to full screen. */}
        <fieldset className="border-y border-border bg-card px-2 py-3 sm:px-4">
          <legend className="sr-only">
            {decisionEnabled ? t("review.compare.selectToKeep") : t("review.compare.title")}
          </legend>
          <div className="mb-2 flex min-w-0 items-start gap-2">
            {recommendedLabel === null ? (
              <FiInfo className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            ) : (
              <FiCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-suggest" aria-hidden />
            )}
            <p className="min-w-0 text-3xs leading-relaxed text-muted-foreground">
              <strong className="font-semibold text-foreground">
                {decisionEnabled
                  ? t("review.compare.selectToKeep")
                  : recommendedLabel === null
                    ? t("review.compare.recommendation")
                    : t("review.resolve.recommended", { name: recommendedLabel })}
              </strong>
              {" — "}
              {recommendedLabel === null
                ? t("review.compare.recommendationNone")
                : decisionEnabled
                  ? `${t("review.resolve.recommended", { name: recommendedLabel })}. ${
                      recommendationReason ?? ""
                    }`.trim()
                  : (recommendationReason ?? recommendedLabel)}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {/* Radios, not toggle buttons: exactly one copy is kept, and a
                pair of independent `aria-pressed` buttons neither says so nor
                answers the arrow keys a reader reaches for. */}
            {([a, b] as const).map((file, index) => {
              const selected = decisionEnabled && draftId === file.id;
              const recommended = recommendedId === file.id;
              const facts = `${
                file.facts ? formatBytes(file.facts.size_bytes, { locale }) : unknown
              } · ${resolution(file)}`;
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      {/* The side letter is part of the control's accessible
                          name — "A · IMG_4382.jpg" — because the footer, the
                          overlay badges and the keyboard hints all refer to
                          the sides by letter. */}
                      <span className="shrink-0 text-3xs font-bold text-faint">
                        {index === 0 ? letterA : letterB} ·
                      </span>
                      <span className="truncate text-xs font-semibold text-foreground">
                        {index === 0 ? nameA : nameB}
                      </span>
                      {recommended && (
                        <Badge tone="suggest">{t("review.resolve.recommendation")}</Badge>
                      )}
                    </span>
                    {/* State the selection in words, never by border colour alone. */}
                    <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                      {facts}
                      {decisionEnabled &&
                        ` · ${
                          selected
                            ? t("review.compare.willBeKept")
                            : t("review.compare.notSelected")
                        }`}
                    </span>
                  </span>
                  {decisionEnabled && (
                    <input
                      type="radio"
                      name="review-compare-keeper"
                      checked={selected}
                      onChange={() => setDraftId(file.id)}
                      className="h-4 w-4 shrink-0 border-border-strong text-primary focus-visible:outline-none"
                    />
                  )}
                </>
              );
              const frame = cn(
                "flex min-h-11 min-w-0 items-center gap-2 rounded-control border px-3 py-2 text-left",
                "transition-[border-color,background-color,box-shadow]",
                selected
                  ? "border-primary bg-tint-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]"
                  : recommended
                    ? "border-dashed border-suggest bg-tint-suggest"
                    : "border-border",
              );
              return (
                <div key={file.id} className="flex min-w-0 items-stretch gap-2">
                  {decisionEnabled ? (
                    <label
                      className={cn(
                        frame,
                        "flex-1 cursor-pointer focus-within:ring-2 focus-within:ring-ring",
                        !selected && !recommended && "hover:border-border-strong hover:bg-muted/50",
                      )}
                    >
                      {body}
                    </label>
                  ) : (
                    <div className={cn(frame, "flex-1")}>{body}</div>
                  )}
                  {/* Outside the label on purpose: a button inside one toggles
                      the radio it sits in, so enlarging would pick a keeper. */}
                  {onEnlarge && (
                    <Tooltip label={t("review.viewer.open", { name: getBasename(file.label) })}>
                      <button
                        type="button"
                        onClick={() => onEnlarge(file.path)}
                        aria-label={t("review.viewer.open", { name: getBasename(file.label) })}
                        className="grid w-9 shrink-0 place-items-center rounded-control border border-border text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <FiMaximize className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="border-b border-border bg-card px-3 py-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t("review.compare.detailsTitle")}
          </h3>
          <p className="mt-0.5 text-3xs text-muted-foreground">{t("review.compare.detailsHelp")}</p>
        </div>
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-3xs font-semibold uppercase tracking-[0.07em] text-faint sm:grid-cols-[7rem_1fr_1fr]">
          <span />
          {/* Column headings link to each file's full details. */}
          {(
            [
              [t("review.compare.column", { letter: letterA, name: nameA }), a],
              [t("review.compare.column", { letter: letterB, name: nameB }), b],
            ] as const
          ).map(([label, file]) => (
            <span key={file.id} className="flex min-w-0 items-center gap-2">
              {onOpenDetail ? (
                <button
                  type="button"
                  onClick={() => onOpenDetail(file.path)}
                  className="inline-flex min-h-6 min-w-0 items-center truncate rounded-control text-left uppercase tracking-[0.07em] underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {label}
                </button>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </span>
          ))}
        </div>
        {orderFacts<CompareFact>([
          { id: "fileType", left: mediaKind(a), right: mediaKind(b) },
          {
            id: "resolution",
            left: resolution(a),
            right: resolution(b),
            winner: larger(pixels(a), pixels(b)),
            winnerNote: t("review.compare.wins.moreDetail"),
          },
          {
            id: "megapixels",
            left: megapixels(a),
            right: megapixels(b),
            winner: larger(pixels(a), pixels(b)),
            winnerNote: t("review.compare.wins.moreDetail"),
          },
          eitherVideo
            ? {
                id: "duration",
                left: duration(a),
                right: duration(b),
                winner: bothVideos
                  ? larger(factNumber(a, "duration_seconds"), factNumber(b, "duration_seconds"))
                  : null,
                winnerNote: t("review.compare.wins.longer"),
              }
            : null,
          eitherVideo ? { id: "codec", left: codec(a), right: codec(b) } : null,
          {
            id: "size",
            left: a.facts ? formatBytes(a.facts.size_bytes, { locale }) : unknown,
            right: b.facts ? formatBytes(b.facts.size_bytes, { locale }) : unknown,
            winner: larger(a.facts?.size_bytes ?? null, b.facts?.size_bytes ?? null),
            winnerNote: t("review.compare.wins.larger"),
          },
          {
            id: "date",
            left: capture(a),
            right: capture(b),
            winner: larger(capturedAt(a), capturedAt(b)),
            winnerNote: t("review.compare.wins.newer"),
          },
          { id: "source", left: a.label, right: b.label },
          {
            id: "destination",
            left: a.destination === undefined ? unknown : (a.destination ?? unknown),
            right: b.destination === undefined ? unknown : (b.destination ?? unknown),
          },
          {
            id: "result",
            left: a.plannedStatus ? plannedStatusLabel(a.plannedStatus, t) : unknown,
            right: b.plannedStatus ? plannedStatusLabel(b.plannedStatus, t) : unknown,
          },
          {
            id: "confidence",
            left: a.confidence === null ? unknown : t(`review.confidenceValue.${a.confidence}`),
            right: b.confidence === null ? unknown : t(`review.confidenceValue.${b.confidence}`),
            winner: larger(
              a.confidence === null ? null : (CONFIDENCE_RANK[a.confidence] ?? null),
              b.confidence === null ? null : (CONFIDENCE_RANK[b.confidence] ?? null),
            ),
            winnerNote: t("review.compare.wins.stronger"),
          },
          {
            id: "protection",
            left: a.protected ? t("review.referenceProtected") : t("review.detail.mutable"),
            right: b.protected ? t("review.referenceProtected") : t("review.detail.mutable"),
          },
          { id: "mediaUnit", left: unit(a), right: unit(b) },
          { id: "companions", left: companionEvidence(a), right: companionEvidence(b) },
          { id: "unitWarnings", left: warnings(a), right: warnings(b) },
        ]).map((fact) => (
          <FactRow
            key={fact.id}
            label={t(REVIEW_FACT_LABELS[fact.id])}
            left={fact.left}
            right={fact.right}
            winner={fact.winner ?? null}
            winnerNote={fact.winnerNote ?? ""}
          />
        ))}
      </ModalBody>

      <ModalFooter>
        <span className="mr-auto min-w-0 text-3xs text-faint">
          {decisionLocked ? (
            <span className="block">{t("review.compare.referenceLocked")}</span>
          ) : sameSet ? (
            <>
              <span className="block" aria-live="polite">
                {draftId === null
                  ? t("review.compare.nothingSelected")
                  : t("review.compare.selectionState", {
                      name: getBasename((draftId === a.id ? a : b).label),
                    })}
              </span>
              <span className="block">{t("review.compare.scopeNote")}</span>
              <span
                className={cn("block min-h-4", saveError ? "text-error" : "text-muted-foreground")}
                role="status"
              >
                {saveError
                  ? t("review.persistence.saveFailed")
                  : slowSave
                    ? t("review.persistence.saving")
                    : ""}
              </span>
            </>
          ) : (
            t("review.compare.notOneSet")
          )}
        </span>
        {comparisonPosition && (
          <div className="flex items-center gap-1 border-r border-border pr-2">
            <Tooltip label={t("review.compare.previousCopy")}>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("review.compare.previousCopy")}
                onClick={comparisonPosition.onPrevious}
              >
                <FiChevronLeft className="h-4 w-4" aria-hidden />
              </Button>
            </Tooltip>
            <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
              {t("review.compare.copyPosition", {
                index: comparisonPosition.index + 1,
                total: comparisonPosition.total,
              })}
            </span>
            <Tooltip label={t("review.compare.nextCopy")}>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("review.compare.nextCopy")}
                onClick={comparisonPosition.onNext}
              >
                <FiChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </Tooltip>
          </div>
        )}
        {(onPreviousSet || onNextSet) && (
          <div className="flex items-center gap-1 sm:border-r sm:border-border sm:pr-2">
            <Tooltip label={t("review.compare.previousSet")}>
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
            </Tooltip>
            <Tooltip label={t("review.compare.nextSet")}>
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
            </Tooltip>
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("review.compare.back")}
        </Button>
        {decisionEnabled && (
          <>
            {saveError && onRetrySave && (
              <Button size="sm" variant="outline" onClick={onRetrySave}>
                {t("state.retry")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraftId(null);
                onKeepBoth();
              }}
              disabled={saving}
            >
              {t("review.compare.keepBoth", { count: setMemberCount })}
            </Button>
            <Button
              size="sm"
              disabled={saving || draftId === null || draftId === keeperId}
              onClick={() => draftId && onKeep(draftId)}
            >
              {t(
                !saving && !saveError && draftId !== null && draftId === keeperId
                  ? "review.compare.applied"
                  : "review.compare.confirmSelection",
              )}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
