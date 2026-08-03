import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { MediaImage } from "@/components/ui/media-image";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/setting-row";
import { Thumbnail } from "@/components/ui/thumbnail";
import { PathActions } from "@/components/MediaPreviewModal";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { getBasename } from "@/lib/pathUtils";
import { useMediaInfo, formatResolution } from "@/hooks/useMediaInfo";
import { useI18n } from "@/i18n/I18nContext";
import type { MediaInfo, PreviewItem } from "@/types/api";
import { FiAward, FiZoomIn, FiChevronLeft, FiChevronRight } from "react-icons/fi";

// ── Types ──────────────────────────────────────────────────────────────────────

type ViewMode = "side-by-side" | "diff" | "slider";

/** The prev/next control, identical here and in the media preview. */
const NAV_BUTTON =
  "rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30";

interface DetailRow {
  label: string;
  origValue: string;
  dupValue: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDetailRows(
  origInfo: MediaInfo | undefined,
  dupInfo: MediaInfo | undefined,
  item: PreviewItem,
  t: Translate,
  locale: string,
): DetailRow[] {
  return [
    {
      label: t("duplicate.date"),
      origValue: origInfo?.extracted_date ?? "—",
      dupValue: item.extracted_date ?? "—",
    },
    {
      label: t("duplicate.source"),
      origValue: formatMetadataSource(origInfo?.metadata_source, t),
      dupValue: formatMetadataSource(item.metadata_source, t),
    },
    {
      label: t("duplicate.size"),
      origValue: formatBytes(origInfo?.file_size, { locale }),
      dupValue: formatBytes(item.file_size, { locale }),
    },
    {
      label: t("duplicate.resolution"),
      origValue: formatResolution(origInfo?.width, origInfo?.height),
      dupValue: formatResolution(dupInfo?.width, dupInfo?.height),
    },
  ];
}

function getWinnerReason(
  origInfo: MediaInfo | undefined,
  dupInfo: MediaInfo | undefined,
  item: PreviewItem,
  t: Translate,
  locale: string,
): string | null {
  if (item.duplicate_type === "exact") return t("duplicate.reason.exact");
  if (!origInfo || !dupInfo) return null;

  const isImageComparison = origInfo.media_type === "image" || dupInfo.media_type === "image";

  if (isImageComparison) {
    const origMp = (origInfo.width ?? 0) * (origInfo.height ?? 0);
    const dupMp = (dupInfo.width ?? 0) * (dupInfo.height ?? 0);
    if (origMp > dupMp)
      return t("duplicate.reason.higherResolution", {
        original: `${origInfo.width}×${origInfo.height}`,
        duplicate: `${dupInfo.width ?? "?"}×${dupInfo.height ?? "?"}`,
      });
    if (dupMp > origMp)
      return t("duplicate.reason.lowerResolution", {
        original: `${origInfo.width}×${origInfo.height}`,
        duplicate: `${dupInfo.width ?? "?"}×${dupInfo.height ?? "?"}`,
      });
    const origSize = origInfo.file_size ?? 0;
    const dupSize = item.file_size ?? 0;
    if (origSize > dupSize)
      return t("duplicate.reason.largerSameResolution", {
        original: formatBytes(origSize, { locale }),
        duplicate: formatBytes(dupSize, { locale }),
      });
    if (dupSize > origSize) return t("duplicate.reason.smallerSameResolution");
    return t("duplicate.reason.identicalQuality");
  } else {
    const origSize = origInfo.file_size ?? 0;
    const dupSize = item.file_size ?? 0;
    if (origSize > dupSize)
      return t("duplicate.reason.larger", {
        original: formatBytes(origSize, { locale }),
        duplicate: formatBytes(dupSize, { locale }),
      });
    if (dupSize > origSize) return t("duplicate.reason.smaller");
    return t("duplicate.reason.sameSize");
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AlignedDetailTable({ rows }: { rows: DetailRow[] }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="py-1.5 pl-3 pr-2 text-left text-2xs font-semibold text-muted-foreground">
              {t("duplicate.field")}
            </th>
            <th className="py-1.5 pr-2 text-left text-2xs font-semibold text-success">
              {t("duplicate.original")}
            </th>
            <th className="py-1.5 pr-3 text-left text-2xs font-semibold text-info">
              {t("duplicate.duplicate")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ label, origValue, dupValue }) => {
            const differs = origValue !== dupValue && origValue !== "—" && dupValue !== "—";
            return (
              <tr key={label} className={cn("transition-colors", differs && "bg-warning/10")}>
                <td className="py-1.5 pl-3 pr-2 text-muted-foreground">{label}</td>
                <td
                  className={cn(
                    "py-1.5 pr-2 font-mono",
                    differs ? "font-semibold text-success" : "text-foreground",
                  )}
                >
                  {origValue}
                </td>
                <td
                  className={cn(
                    "py-1.5 pr-3 font-mono",
                    differs ? "font-semibold text-foreground" : "text-foreground",
                  )}
                >
                  {dupValue}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClickableThumb({
  path,
  onEnlarge,
  className,
}: {
  path: string;
  onEnlarge: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Thumbnail
      path={path}
      maxPx={640}
      onOpen={onEnlarge}
      openLabel={t("duplicate.viewEnlarged")}
      className={cn("h-44 w-full rounded-lg border border-border bg-muted/40", className)}
    />
  );
}

// ── Slider view ────────────────────────────────────────────────────────────────

function ImageComparisonSlider({
  originalPath,
  duplicatePath,
  onEnlargeOriginal,
  onEnlargeDuplicate,
}: {
  originalPath: string;
  duplicatePath: string;
  onEnlargeOriginal: () => void;
  onEnlargeDuplicate: () => void;
}) {
  const { t } = useI18n();
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const updatePos = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setSliderPos(pos);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      updatePos(e.clientX);

      const onMove = (ev: MouseEvent) => {
        if (isDragging.current) updatePos(ev.clientX);
      };
      const onUp = () => {
        isDragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [updatePos],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (touch) updatePos(touch.clientX);

      const onMove = (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (t) updatePos(t.clientX);
      };
      const onEnd = () => {
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
      };
      window.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("touchend", onEnd);
    },
    [updatePos],
  );

  return (
    <div className="space-y-2">
      {/* Comparison container */}
      <div
        ref={containerRef}
        className="relative select-none overflow-hidden rounded-lg border border-border bg-black/5 cursor-ew-resize"
        style={{ height: "45vh" }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(sliderPos)}
        aria-label={t("duplicate.sliderLabel")}
      >
        {/* Duplicate image — full width background */}
        <MediaImage
          src={api.thumbnailUrl(duplicatePath, 900)}
          alt={t("duplicate.duplicate")}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
        />

        {/* Original image — clipped to the left portion */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
          aria-hidden
        >
          <MediaImage
            src={api.thumbnailUrl(originalPath, 900)}
            alt={t("duplicate.original")}
            className="absolute inset-0 h-full w-full select-none object-contain"
          />
        </div>

        {/* Corner labels */}
        <div className="pointer-events-none absolute left-2 top-2">
          <span className="rounded bg-black/60 px-2 py-0.5 text-2xs font-semibold text-white">
            {t("duplicate.original")}
          </span>
        </div>
        <div className="pointer-events-none absolute right-2 top-2">
          <span className="rounded bg-black/60 px-2 py-0.5 text-2xs font-semibold text-white">
            {t("duplicate.duplicate")}
          </span>
        </div>

        {/* Divider line + handle */}
        <div
          className="pointer-events-none absolute inset-y-0 w-[3px] bg-white/90 shadow-[0_0_8px_rgba(0,0,0,0.4)]"
          style={{ left: `${sliderPos}%`, transform: "translateX(-50%)" }}
          aria-hidden
        >
          <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-md">
            <svg
              width="14"
              height="10"
              viewBox="0 0 14 10"
              fill="none"
              aria-hidden
              className="text-black/70"
            >
              <path
                d="M1 5h12M1 5L4 2M1 5L4 8M13 5L10 2M13 5L10 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* Enlarge buttons */}
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={onEnlargeOriginal}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FiZoomIn className="h-3 w-3" />
          {t("duplicate.viewOriginal")}
        </button>
        <button
          type="button"
          onClick={onEnlargeDuplicate}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FiZoomIn className="h-3 w-3" />
          {t("duplicate.viewDuplicate")}
        </button>
      </div>
      <p className="text-center text-2xs text-muted-foreground">{t("duplicate.sliderHelp")}</p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface DuplicateComparisonProps {
  item: PreviewItem;
  /** All preview items — used to look up the original file's destination. */
  allItems?: PreviewItem[];
  copyInsteadOfMove?: boolean;
  onClose: () => void;
}

export function DuplicateComparison({
  item: initialItem,
  allItems,
  copyInsteadOfMove,
  onClose,
}: DuplicateComparisonProps) {
  const { t, locale } = useI18n();
  const [item, setItem] = useState(initialItem);
  const [viewMode, setViewMode] = useState<ViewMode>("side-by-side");
  const [diffBroken, setDiffBroken] = useState(false);
  const [enlargedUrl, setEnlargedUrl] = useState<string | null>(null);

  // Sync when the parent opens a different duplicate
  useEffect(() => {
    setItem(initialItem);
    setEnlargedUrl(null);
    setDiffBroken(false);
  }, [initialItem]);

  // Navigation through all duplicates in the list
  const duplicateItems = useMemo(
    () =>
      (allItems ?? []).filter(
        (i) => i.status === "duplicate" || i.status === "already_in_destination",
      ),
    [allItems],
  );
  const dupIdx = duplicateItems.findIndex((d) => d.source === item.source);
  const hasPrev = dupIdx > 0;
  const hasNext = dupIdx < duplicateItems.length - 1 && dupIdx >= 0;

  const goPrev = useCallback(() => {
    if (dupIdx > 0) {
      setItem(duplicateItems[dupIdx - 1]);
      setEnlargedUrl(null);
      setDiffBroken(false);
    }
  }, [dupIdx, duplicateItems]);

  const goNext = useCallback(() => {
    if (dupIdx < duplicateItems.length - 1 && dupIdx >= 0) {
      setItem(duplicateItems[dupIdx + 1]);
      setEnlargedUrl(null);
      setDiffBroken(false);
    }
  }, [dupIdx, duplicateItems]);

  // Escape belongs to the dialog shell; only the arrow keys are ours, and only
  // while the enlarged overlay is not the thing on top.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (enlargedUrl) return;
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlargedUrl, goPrev, goNext]);

  const isExact = item.duplicate_type === "exact";
  const similarityLabel = isExact
    ? t("duplicate.exact")
    : t("duplicate.similar", { percentage: item.duplicate_similarity ?? 0 });
  const original = item.duplicate_of ?? "";

  // Look up the original file's destination (it's a "sort" item in allItems)
  const originalDestination = allItems?.find((i) => i.source === original)?.destination ?? null;

  const { data: origInfo } = useMediaInfo(original);
  const { data: dupInfo } = useMediaInfo(item.source);

  const bothImages = origInfo?.media_type === "image" && dupInfo?.media_type === "image";
  const canDiff = bothImages && !diffBroken && !!original;
  const canSlider = !!original;

  const winnerReason = getWinnerReason(origInfo, dupInfo, item, t, locale);
  const detailRows = buildDetailRows(origInfo, dupInfo, item, t, locale);

  // Footer message adapts to whether it's a copy or move operation
  const footerHint = copyInsteadOfMove ? t("duplicate.copyHint") : t("duplicate.moveHint");

  const viewOptions: { key: ViewMode; label: string }[] = [
    { key: "side-by-side", label: t("duplicate.sideBySide") },
    ...(canSlider ? [{ key: "slider" as ViewMode, label: t("duplicate.slider") }] : []),
    ...(canDiff ? [{ key: "diff" as ViewMode, label: t("duplicate.diff") }] : []),
  ];

  return (
    <>
      <Modal open onClose={onClose} title={t("duplicate.compare")} size="lg">
        <ModalHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {viewOptions.length > 1 && (
                <Segmented
                  name="duplicate-compare-mode"
                  label={t("duplicate.compare")}
                  value={viewMode}
                  options={viewOptions.map(({ key, label }) => ({ value: key, label }))}
                  onChange={setViewMode}
                />
              )}

              {duplicateItems.length > 1 && (
                <>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {dupIdx + 1} / {duplicateItems.length}
                  </span>
                  <button
                    type="button"
                    onClick={goPrev}
                    disabled={!hasPrev}
                    className={NAV_BUTTON}
                    aria-label={t("duplicate.previous")}
                  >
                    <FiChevronLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!hasNext}
                    className={NAV_BUTTON}
                    aria-label={t("duplicate.next")}
                  >
                    <FiChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                </>
              )}
            </div>
          }
        >
          <span className="rounded-full bg-info/15 px-2.5 py-0.5 text-2xs font-semibold text-info">
            {similarityLabel}
          </span>
        </ModalHeader>

        <ModalBody className="px-0 py-0">
          {/* ── Side by side ── */}
          {viewMode === "side-by-side" && (
            <div className="space-y-4 px-5 py-5">
              {/* Thumbnails + names */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-success">
                    {t("duplicate.originalKept")}
                  </p>
                  <ClickableThumb
                    path={original}
                    onEnlarge={() => setEnlargedUrl(api.thumbnailUrl(original, 1400))}
                  />
                  <p className="truncate text-sm font-medium text-foreground" title={original}>
                    {getBasename(original)}
                  </p>
                  {winnerReason ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-success/20 bg-success/10 px-2.5 py-1.5 text-2xs text-success">
                      <FiAward className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{winnerReason}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("duplicate.firstKept")}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-info">
                    {t("duplicate.duplicate")}
                  </p>
                  <ClickableThumb
                    path={item.source}
                    onEnlarge={() => setEnlargedUrl(api.thumbnailUrl(item.source, 1400))}
                  />
                  <p className="truncate text-sm font-medium text-foreground" title={item.source}>
                    {getBasename(item.source)}
                  </p>
                </div>
              </div>

              {/* Aligned detail table */}
              <AlignedDetailTable rows={detailRows} />

              {/* Paths — Source then actions then Destination, for both sides */}
              <div className="grid grid-cols-2 gap-4">
                {/* Original (left / kept) */}
                <div className="space-y-1.5">
                  <p className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("duplicate.source")}
                  </p>
                  <p
                    className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-3xs text-foreground"
                    title={original}
                  >
                    {original}
                  </p>
                  <PathActions path={original} compact />
                  {originalDestination && (
                    <>
                      <p className="pt-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("duplicate.destination")}
                      </p>
                      <p
                        className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-3xs text-muted-foreground"
                        title={originalDestination}
                      >
                        {originalDestination}
                      </p>
                    </>
                  )}
                </div>

                {/* Duplicate (right) */}
                <div className="space-y-1.5">
                  <p className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("duplicate.source")}
                  </p>
                  <p
                    className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-3xs text-foreground"
                    title={item.source}
                  >
                    {item.source}
                  </p>
                  <PathActions path={item.source} compact />
                  {item.destination && (
                    <>
                      <p className="pt-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("duplicate.destination")}
                      </p>
                      <p
                        className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-3xs text-muted-foreground"
                        title={item.destination}
                      >
                        {item.destination}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Slider ── */}
          {viewMode === "slider" && canSlider && (
            <div className="px-5 py-5">
              <ImageComparisonSlider
                originalPath={original}
                duplicatePath={item.source}
                onEnlargeOriginal={() => setEnlargedUrl(api.thumbnailUrl(original, 1400))}
                onEnlargeDuplicate={() => setEnlargedUrl(api.thumbnailUrl(item.source, 1400))}
              />
            </div>
          )}

          {/* ── Diff heatmap ── */}
          {viewMode === "diff" && canDiff && (
            <div className="space-y-3 px-5 py-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("duplicate.diffTitle")}
              </p>
              <button
                type="button"
                className="relative block w-full cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setEnlargedUrl(api.diffUrl(original, item.source, 1400))}
                aria-label={t("duplicate.viewDiff")}
              >
                <MediaImage
                  src={api.diffUrl(original, item.source, 768)}
                  alt={t("duplicate.diffAlt")}
                  className="mx-auto max-h-[50dvh] w-full rounded-lg border border-border object-contain"
                  fallback={
                    <p className="py-10 text-center text-xs text-muted-foreground">
                      {t("duplicate.diffHelp")}
                    </p>
                  }
                />
              </button>
              <p className="text-2xs text-muted-foreground">{t("duplicate.diffHelp")}</p>
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <span className="mr-auto text-xs text-muted-foreground">{footerHint}</span>
        </ModalFooter>
      </Modal>

      {enlargedUrl && (
        <ImageLightbox
          src={enlargedUrl}
          title={getBasename(item.source)}
          onClose={() => setEnlargedUrl(null)}
        />
      )}
    </>
  );
}
