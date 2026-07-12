import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Thumbnail } from "@/components/ui/thumbnail";
import { PathActions } from "@/components/MediaPreviewModal";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMediaInfo, formatResolution } from "@/hooks/useMediaInfo";
import type { MediaInfo, PreviewItem } from "@/types/api";
import { FiX, FiAward, FiZoomIn, FiChevronLeft, FiChevronRight } from "react-icons/fi";

// ── Types ──────────────────────────────────────────────────────────────────────

type ViewMode = "side-by-side" | "diff" | "slider";

interface DetailRow {
  label: string;
  origValue: string;
  dupValue: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDetailRows(
  origInfo: MediaInfo | undefined,
  dupInfo: MediaInfo | undefined,
  item: PreviewItem,
): DetailRow[] {
  const origSource =
    origInfo?.metadata_source && origInfo.metadata_source !== "none"
      ? origInfo.metadata_source
      : "—";
  return [
    {
      label: "Date",
      origValue: origInfo?.extracted_date ?? "—",
      dupValue: item.extracted_date ?? "—",
    },
    {
      label: "Source",
      origValue: origSource,
      dupValue: item.metadata_source || "—",
    },
    {
      label: "Size",
      origValue: formatBytes(origInfo?.file_size),
      dupValue: formatBytes(item.file_size),
    },
    {
      label: "Resolution",
      origValue: formatResolution(origInfo?.width, origInfo?.height),
      dupValue: formatResolution(dupInfo?.width, dupInfo?.height),
    },
  ];
}

function getWinnerReason(
  origInfo: MediaInfo | undefined,
  dupInfo: MediaInfo | undefined,
  item: PreviewItem,
): string | null {
  if (item.duplicate_type === "exact") return "Exact byte-for-byte match — identical content";
  if (!origInfo || !dupInfo) return null;

  const isImageComparison = origInfo.media_type === "image" || dupInfo.media_type === "image";

  if (isImageComparison) {
    const origMp = (origInfo.width ?? 0) * (origInfo.height ?? 0);
    const dupMp = (dupInfo.width ?? 0) * (dupInfo.height ?? 0);
    if (origMp > dupMp)
      return `Higher resolution (${origInfo.width}×${origInfo.height} vs ${dupInfo.width ?? "?"}×${dupInfo.height ?? "?"})`;
    if (dupMp > origMp)
      return `Lower resolution (${dupInfo.width ?? "?"}×${dupInfo.height ?? "?"} vs ${origInfo.width}×${origInfo.height}) — seen first`;
    const origSize = origInfo.file_size ?? 0;
    const dupSize = item.file_size ?? 0;
    if (origSize > dupSize)
      return `Same resolution, larger file (${formatBytes(origSize)} vs ${formatBytes(dupSize)})`;
    if (dupSize > origSize) return "Same resolution, smaller file — seen first";
    return "Identical quality — seen first wins";
  } else {
    const origSize = origInfo.file_size ?? 0;
    const dupSize = item.file_size ?? 0;
    if (origSize > dupSize)
      return `Larger file (${formatBytes(origSize)} vs ${formatBytes(dupSize)})`;
    if (dupSize > origSize) return "Smaller file — seen first";
    return "Same size — seen first wins";
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AlignedDetailTable({ rows }: { rows: DetailRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="py-1.5 pl-3 pr-2 text-left text-[11px] font-semibold text-muted-foreground">
              Field
            </th>
            <th className="py-1.5 pr-2 text-left text-[11px] font-semibold text-success">
              Original
            </th>
            <th className="py-1.5 pr-3 text-left text-[11px] font-semibold text-info">Duplicate</th>
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
  return (
    <button
      type="button"
      className={cn(
        "group relative block w-full overflow-hidden rounded-lg border border-border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={onEnlarge}
      aria-label="View image enlarged"
    >
      <Thumbnail path={path} maxPx={640} className="h-44 w-full" />
      <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 transition-all group-hover:bg-black/25">
        <FiZoomIn className="h-6 w-6 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" />
      </span>
    </button>
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
  const [sliderPos, setSliderPos] = useState(50);
  const [origLoaded, setOrigLoaded] = useState(false);
  const [dupLoaded, setDupLoaded] = useState(false);
  const imagesReady = origLoaded && dupLoaded;
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
        aria-label="Image comparison slider — drag to compare original and duplicate"
      >
        {/* Loading spinner — shown until both images are ready */}
        {!imagesReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/60">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
          </div>
        )}

        {/* Duplicate image — full width background */}
        <img
          src={api.thumbnailUrl(duplicatePath, 900)}
          alt="Duplicate"
          draggable={false}
          onLoad={() => setDupLoaded(true)}
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full select-none object-contain transition-opacity duration-200",
            imagesReady ? "opacity-100" : "opacity-0",
          )}
        />

        {/* Original image — clipped to the left portion */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
          aria-hidden
        >
          <img
            src={api.thumbnailUrl(originalPath, 900)}
            alt="Original"
            draggable={false}
            onLoad={() => setOrigLoaded(true)}
            className="h-full w-full select-none object-contain"
          />
        </div>

        {/* Corner labels */}
        <div className="pointer-events-none absolute left-2 top-2">
          <span className="rounded bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            Original
          </span>
        </div>
        <div className="pointer-events-none absolute right-2 top-2">
          <span className="rounded bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            Duplicate
          </span>
        </div>

        {/* Divider line + handle */}
        <div
          className="pointer-events-none absolute inset-y-0 w-[3px] bg-white/90 shadow-[0_0_8px_rgba(0,0,0,0.4)]"
          style={{ left: `${sliderPos}%`, transform: "translateX(-50%)" }}
          aria-hidden
        >
          <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-md">
            <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
              <path
                d="M1 5h12M1 5L4 2M1 5L4 8M13 5L10 2M13 5L10 8"
                stroke="#555"
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
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FiZoomIn className="h-3 w-3" />
          View Original
        </button>
        <button
          type="button"
          onClick={onEnlargeDuplicate}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FiZoomIn className="h-3 w-3" />
          View Duplicate
        </button>
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        Drag the divider to compare — original on the left, duplicate on the right.
      </p>
    </div>
  );
}

// ── Enlarged image overlay ─────────────────────────────────────────────────────

function EnlargedOverlay({ url, onClose }: { url: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/75 backdrop-blur-md cursor-zoom-out p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Enlarged image"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white transition-colors hover:bg-white/30"
        aria-label="Close enlarged view"
      >
        <FiX className="h-5 w-5" />
      </button>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
        </div>
      )}
      {/* Subtle panel so the image never floats on raw black when it doesn't fill the space */}
      <div
        className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl bg-white/5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={url}
          alt="Enlarged view"
          onLoad={() => setLoaded(true)}
          className={cn(
            "max-h-[88vh] max-w-[88vw] cursor-default object-contain transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </div>,
    document.body,
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
  const [item, setItem] = useState(initialItem);
  const [viewMode, setViewMode] = useState<ViewMode>("side-by-side");
  const [diffBroken, setDiffBroken] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [enlargedUrl, setEnlargedUrl] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enlargedUrl) onClose();
      if (e.key === "ArrowLeft" && !enlargedUrl) goPrev();
      if (e.key === "ArrowRight" && !enlargedUrl) goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enlargedUrl, goPrev, goNext]);

  useEffect(() => {
    if (viewMode === "diff") setDiffLoading(true);
  }, [viewMode]);

  const isExact = item.duplicate_type === "exact";
  const similarityLabel = isExact
    ? "Exact match · 100%"
    : `~${item.duplicate_similarity ?? 0}% similar`;
  const original = item.duplicate_of ?? "";

  // Look up the original file's destination (it's a "sort" item in allItems)
  const originalDestination = allItems?.find((i) => i.source === original)?.destination ?? null;

  const { data: origInfo } = useMediaInfo(original);
  const { data: dupInfo } = useMediaInfo(item.source);

  const bothImages = origInfo?.media_type === "image" && dupInfo?.media_type === "image";
  const canDiff = bothImages && !diffBroken && !!original;
  const canSlider = !!original;

  const winnerReason = getWinnerReason(origInfo, dupInfo, item);
  const detailRows = buildDetailRows(origInfo, dupInfo, item);

  // Footer message adapts to whether it's a copy or move operation
  const footerHint = copyInsteadOfMove
    ? "The duplicate will be copied to _duplicates/ — your source files stay untouched."
    : "The duplicate will be moved to _duplicates/. The original stays in place.";

  const viewOptions: { key: ViewMode; label: string }[] = [
    { key: "side-by-side", label: "Side by side" },
    ...(canSlider ? [{ key: "slider" as ViewMode, label: "Slider" }] : []),
    ...(canDiff ? [{ key: "diff" as ViewMode, label: "Diff" }] : []),
  ];

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label="Duplicate comparison"
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Compare duplicate</h2>
            <div className="flex items-center gap-2">
              {/* View mode toggle */}
              {viewOptions.length > 1 && (
                <div className="flex overflow-hidden rounded-md border border-border text-xs">
                  {viewOptions.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setViewMode(key)}
                      className={cn(
                        "px-2.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        viewMode === key
                          ? "bg-primary text-primary-foreground"
                          : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Duplicate navigation */}
              {duplicateItems.length > 1 && (
                <>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {dupIdx + 1} / {duplicateItems.length}
                  </span>
                  <button
                    type="button"
                    onClick={goPrev}
                    disabled={!hasPrev}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Previous duplicate"
                  >
                    <FiChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!hasNext}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Next duplicate"
                  >
                    <FiChevronRight className="h-4 w-4" />
                  </button>
                </>
              )}

              {/* Similarity badge — always blue */}
              <span className="rounded-full bg-info/15 px-3 py-1 text-xs font-semibold text-info">
                {similarityLabel}
              </span>

              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close comparison"
              >
                <FiX className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* ── Side by side ── */}
            {viewMode === "side-by-side" && (
              <div className="space-y-4 px-5 py-5">
                {/* Thumbnails + names */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-success">
                      Original (kept)
                    </p>
                    <ClickableThumb
                      path={original}
                      onEnlarge={() => setEnlargedUrl(api.thumbnailUrl(original, 1400))}
                    />
                    <p className="truncate text-sm font-medium text-foreground" title={original}>
                      {getBasename(original)}
                    </p>
                    {winnerReason ? (
                      <div className="flex items-start gap-1.5 rounded-md border border-success/20 bg-success/10 px-2.5 py-1.5 text-[11px] text-success">
                        <FiAward className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{winnerReason}</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        First file seen with this content. This copy is kept.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-info">
                      Duplicate
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
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Source
                    </p>
                    <p
                      className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-[10px] text-foreground"
                      title={original}
                    >
                      {original}
                    </p>
                    <PathActions path={original} compact />
                    {originalDestination && (
                      <>
                        <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Destination
                        </p>
                        <p
                          className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-[10px] text-muted-foreground"
                          title={originalDestination}
                        >
                          {originalDestination}
                        </p>
                      </>
                    )}
                  </div>

                  {/* Duplicate (right) */}
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Source
                    </p>
                    <p
                      className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-[10px] text-foreground"
                      title={item.source}
                    >
                      {item.source}
                    </p>
                    <PathActions path={item.source} compact />
                    {item.destination && (
                      <>
                        <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Destination
                        </p>
                        <p
                          className="select-all break-all rounded border border-border bg-muted/40 px-1.5 py-1 font-mono text-[10px] text-muted-foreground"
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
                  Pixel difference heat-map
                </p>
                {diffLoading && (
                  <div className="flex h-40 items-center justify-center">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                )}
                <button
                  type="button"
                  className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setEnlargedUrl(api.diffUrl(original, item.source, 1400))}
                  aria-label="View diff image enlarged"
                >
                  <img
                    src={api.diffUrl(original, item.source, 768)}
                    alt="Pixel difference heat-map between the two images"
                    loading="lazy"
                    decoding="async"
                    onLoad={() => setDiffLoading(false)}
                    onError={() => {
                      setDiffBroken(true);
                      setViewMode("side-by-side");
                      setDiffLoading(false);
                    }}
                    className={cn(
                      "mx-auto max-h-[50vh] w-full cursor-zoom-in rounded-lg border border-border bg-black object-contain transition-opacity hover:opacity-90",
                      diffLoading && "invisible h-0",
                    )}
                  />
                </button>
                {!diffLoading && (
                  <p className="text-[11px] text-muted-foreground">
                    Brightly lit areas differ between the two files; near-black areas are identical.
                    Click to enlarge.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
            {footerHint}
          </div>
        </div>
      </div>

      {enlargedUrl && <EnlargedOverlay url={enlargedUrl} onClose={() => setEnlargedUrl(null)} />}
    </>,
    document.body,
  );
}
