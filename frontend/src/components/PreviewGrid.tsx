import { useState, useRef, useLayoutEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { getBasename } from "@/lib/pathUtils";
import { api } from "@/services/api";
import type { PreviewItem } from "@/types/api";
import { FiFile, FiFilm } from "react-icons/fi";

const VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".3gp",
  ".mts",
  ".m2ts",
]);

// Grid geometry — must stay in sync with the styles below so the windowing
// math matches what the browser actually lays out.
const MIN_COL = 110; // minmax(110px, …)
const GAP = 8; // gap-2
const PAD = 12; // p-3
const CAPTION_H = 52; // min-h-[3rem] caption + padding
const MAX_VIEWPORT = 560; // matches the previous max-h-[560px] wrapper
const OVERSCAN_ROWS = 2;

function isVideo(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTS.has(path.slice(dot).toLowerCase());
}

function getStatusColor(status: string): string {
  switch (status) {
    case "sort":
      return "bg-success";
    case "suspicious_date":
      return "bg-warning";
    case "duplicate":
    case "already_in_destination":
      return "bg-info";
    case "junk":
      return "bg-warning";
    default:
      return "bg-error";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "sort":
      return "Will be sorted";
    case "suspicious_date":
      return "Suspicious date";
    case "duplicate":
      return "Duplicate";
    case "unknown_date":
      return "Unknown date";
    case "future_date":
      return "Future date";
    case "failed":
      return "Failed";
    case "junk":
      return "Junk/thumbnail";
    case "already_in_destination":
      return "Already in destination";
    default:
      return status;
  }
}

function ThumbnailCard({
  item,
  categorizeEnabled,
  onOpen,
}: {
  item: PreviewItem;
  categorizeEnabled: boolean;
  onOpen: (item: PreviewItem) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const name = getBasename(item.source);
  const video = isVideo(item.source);
  const statusDot = getStatusColor(item.status);
  const statusLabel = getStatusLabel(item.status);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-all",
        "hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.status === "duplicate" && "opacity-70",
      )}
      title={`${name} — ${statusLabel}`}
    >
      {/* Thumbnail area */}
      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted/30">
        {!errored ? (
          <>
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
              </div>
            )}
            <img
              src={api.thumbnailUrl(item.source, 240)}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setErrored(true)}
              className={cn(
                "h-full w-full object-cover transition-opacity duration-200",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground/50">
            {video ? <FiFilm className="h-7 w-7" /> : <FiFile className="h-7 w-7" />}
          </div>
        )}

        {/* Video badge */}
        {video && loaded && (
          <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[9px] font-medium text-white">
            <FiFilm className="h-2.5 w-2.5" />
            video
          </span>
        )}

        {/* Status dot */}
        <span
          className={cn(
            "absolute left-1.5 top-1.5 h-2 w-2 rounded-full ring-1 ring-background",
            statusDot,
          )}
          title={statusLabel}
          aria-label={statusLabel}
        />
      </div>

      {/* Caption */}
      <div className="flex min-h-[3rem] flex-col justify-between p-1.5">
        <p
          className="line-clamp-2 text-[11px] font-medium leading-tight text-foreground"
          title={name}
        >
          {name}
        </p>
        {categorizeEnabled && item.status === "sort" && (
          <span
            className={cn(
              "mt-1 self-start rounded-full px-1.5 py-px text-[10px] font-medium leading-none",
              item.category ? "bg-category/10 text-category" : "bg-muted text-muted-foreground",
            )}
            title={item.category ? `Category: ${item.category}` : "Uncategorized"}
          >
            {item.category ?? "_uncategorized"}
          </span>
        )}
      </div>
    </button>
  );
}

export interface PreviewGridProps {
  items: PreviewItem[];
  categorizeEnabled?: boolean;
  onOpen: (item: PreviewItem) => void;
}

/**
 * Row-windowed thumbnail grid. Only the rows overlapping the viewport (plus a
 * small overscan) are mounted, so a library of thousands of files renders a few
 * dozen cards instead of thousands of DOM nodes + lazy <img> requests. Column
 * count and row height are derived from the measured container width so the
 * windowing matches the CSS grid exactly.
 */
export function PreviewGrid({ items, categorizeEnabled = false, onOpen }: PreviewGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewportH, setViewportH] = useState(MAX_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);

  // Measure the scroll container and keep it current on resize.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setViewportH(el.clientHeight || MAX_VIEWPORT);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { columns, rowHeight } = useMemo(() => {
    const inner = Math.max(0, width - PAD * 2);
    if (inner === 0) return { columns: 1, rowHeight: MIN_COL + CAPTION_H + GAP };
    const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_COL + GAP)));
    const cellW = (inner - (cols - 1) * GAP) / cols;
    // Card = square thumbnail (cellW) + caption; rows are separated by GAP.
    return { columns: cols, rowHeight: cellW + CAPTION_H + GAP };
  }, [width]);

  if (items.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        No items match the current filter.
      </div>
    );
  }

  const totalRows = Math.ceil(items.length / columns);
  const totalHeight = totalRows * rowHeight + PAD * 2;
  const firstRow = Math.max(0, Math.floor((scrollTop - PAD) / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    totalRows,
    Math.ceil((scrollTop - PAD + viewportH) / rowHeight) + OVERSCAN_ROWS,
  );
  const firstItem = firstRow * columns;
  const lastItem = Math.min(items.length, lastRow * columns);
  const visible = items.slice(firstItem, lastItem);

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto"
      style={{ maxHeight: MAX_VIEWPORT }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          className="grid gap-2 px-3"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            position: "absolute",
            top: firstRow * rowHeight + PAD,
            left: 0,
            right: 0,
          }}
        >
          {visible.map((item) => (
            <ThumbnailCard
              key={item.source}
              item={item}
              categorizeEnabled={categorizeEnabled}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
