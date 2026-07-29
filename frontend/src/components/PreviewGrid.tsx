import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getBasename } from "@/lib/pathUtils";
import { api } from "@/services/api";
import { useQueuedThumbnail } from "@/lib/thumbnailQueue";
import type { PreviewItem } from "@/types/api";
import { FiFile, FiFilm } from "react-icons/fi";
import { useI18n } from "@/i18n/I18nContext";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";

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

const MAX_VIEWPORT = 560;
const GRID_MIN_COLUMN = 120;

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
    case "duplicate_unknown":
      return "bg-warning";
    default:
      return "bg-error";
  }
}

function getStatusKey(status: string): string {
  switch (status) {
    case "sort":
      return "preview.status.willSort";
    case "suspicious_date":
      return "preview.status.suspicious";
    case "duplicate":
      return "preview.status.duplicate";
    case "unknown_date":
      return "preview.status.unknown";
    case "future_date":
      return "preview.status.future";
    case "failed":
      return "preview.status.failed";
    case "junk":
      return "preview.status.junk";
    case "already_in_destination":
      return "preview.status.inDestination";
    case "duplicate_unknown":
      return "preview.status.duplicateUnknown";
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
  const { t } = useI18n();
  const cardRef = useRef<HTMLButtonElement>(null);
  const { objectUrl, loading, errored } = useQueuedThumbnail(
    api.thumbnailUrl(item.source, 240),
    cardRef,
  );
  const loaded = Boolean(objectUrl);
  const name = getBasename(item.source);
  const video = isVideo(item.source);
  const statusDot = getStatusColor(item.status);
  const statusLabel = t(getStatusKey(item.status), {}, item.status);

  return (
    <button
      ref={cardRef}
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
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
              </div>
            )}
            <img
              src={objectUrl ?? undefined}
              alt=""
              loading="lazy"
              decoding="async"
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
            {t("preview.video")}
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
            title={
              item.category
                ? t("preview.category", { name: item.category })
                : t("preview.uncategorizedLabel")
            }
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
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(GRID_MIN_COLUMN);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.clientWidth || GRID_MIN_COLUMN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.floor(containerWidth / GRID_MIN_COLUMN));
  const totalRows = Math.ceil(items.length / columns);
  const rows = useVirtualWindow({
    count: totalRows,
    estimateSize: Math.max(GRID_MIN_COLUMN + 60, containerWidth / Math.max(columns, 1) + 60),
    maxHeight: MAX_VIEWPORT,
    overscan: 2,
  });

  if (items.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        {t("preview.noMatches")}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="overflow-y-auto"
      style={{ maxHeight: MAX_VIEWPORT }}
      onScroll={rows.onScroll}
    >
      <div className="px-3" style={{ height: rows.totalSize, position: "relative" }}>
        {rows.virtualItems.map((row) => (
          <div
            key={row.index}
            ref={rows.measureElement}
            data-virtual-index={row.index}
            className="grid gap-2 pb-2"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              position: "absolute",
              top: row.start,
              left: 12,
              right: 12,
            }}
          >
            {items
              .slice(row.index * columns, Math.min(items.length, (row.index + 1) * columns))
              .map((item) => (
                <ThumbnailCard
                  key={item.source}
                  item={item}
                  categorizeEnabled={categorizeEnabled}
                  onOpen={onOpen}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
