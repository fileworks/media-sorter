import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { copyPath, revealPath } from "@/lib/reveal";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import { useMediaInfo, formatResolution } from "@/hooks/useMediaInfo";
import type { PreviewItem } from "@/types/api";
import {
  FiX,
  FiCopy,
  FiCheck,
  FiFolder,
  FiChevronLeft,
  FiChevronRight,
  FiFile,
} from "react-icons/fi";

/**
 * Hero image in the preview modal. Displayed on a pure-dark background for
 * maximum contrast. A spinner shows while loading; a placeholder on error.
 */
function ModalImage({ path, maxPx = 2048 }: { path: string; maxPx?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="flex min-h-[160px] w-full items-center justify-center text-white/30">
        <FiFile className="h-12 w-12" />
      </div>
    );
  }

  return (
    <div className="relative flex w-full min-h-[160px] items-center justify-center overflow-hidden">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
        </div>
      )}
      <img
        src={api.thumbnailUrl(path, maxPx)}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={cn(
          "block max-w-full rounded-sm object-contain transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
        )}
        style={{ maxHeight: "58vh", width: "auto" }}
      />
    </div>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Reveal in Explorer";

/**
 * A selectable monospace path field with "Copy path" + "Reveal" actions. Shared
 * by the full preview modal and the duplicate comparison so both expose the same
 * file-management affordances. The copy button flips to a transient "Copied!"
 * state on success.
 */
export function PathActions({ path, compact = false }: { path: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await copyPath(path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const btn =
    "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      {!compact && (
        <p
          className="select-all break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground"
          title={path}
        >
          {path}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onCopy} className={btn} aria-label="Copy full path">
          {copied ? (
            <>
              <FiCheck className="h-3.5 w-3.5 text-primary" />
              <span className="text-primary">Copied!</span>
            </>
          ) : (
            <>
              <FiCopy className="h-3.5 w-3.5" />
              <span>Copy path</span>
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => void revealPath(path)}
          className={btn}
          aria-label={REVEAL_LABEL}
        >
          <FiFolder className="h-3.5 w-3.5" />
          <span>{compact ? "Reveal" : REVEAL_LABEL}</span>
        </button>
      </div>
    </div>
  );
}

interface MediaPreviewModalProps {
  item: PreviewItem;
  /** All navigable items — enables forward/backward arrows. */
  items?: PreviewItem[];
  onClose: () => void;
}

function getStatusLabel(status: PreviewItem["status"]): string {
  switch (status) {
    case "sort":
      return "Will be sorted";
    case "suspicious_date":
      return "Suspicious date — sorted with warning";
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

function getStatusColor(status: PreviewItem["status"]): string {
  switch (status) {
    case "sort":
      return "text-success";
    case "suspicious_date":
      return "text-warning";
    case "duplicate":
    case "already_in_destination":
      return "text-info";
    case "junk":
      return "text-warning";
    default:
      return "text-error";
  }
}

/**
 * Full-size preview of a single media file. Opens as a portal-rendered modal
 * that closes on Escape or a backdrop click. Non-images show a neutral
 * placeholder. When `items` is provided, forward/backward navigation is enabled
 * (also via arrow keys).
 */
export function MediaPreviewModal({ item, items = [], onClose }: MediaPreviewModalProps) {
  const [current, setCurrent] = useState(item);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  // When the initiating item changes from outside (new file clicked), sync.
  useEffect(() => {
    setCurrent(item);
  }, [item]);

  const idx = items.findIndex((i) => i.source === current.source);
  const hasPrev = idx > 0;
  const hasNext = idx < items.length - 1 && idx >= 0;
  const showNav = items.length > 1 && idx >= 0;

  const goPrev = () => {
    if (hasPrev) setCurrent(items[idx - 1]);
  };
  const goNext = () => {
    if (hasNext) setCurrent(items[idx + 1]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // goPrev/goNext are recreated each render but are cheap closures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, idx, hasPrev, hasNext]);

  const name = getBasename(current.source);
  const { data: info } = useMediaInfo(current.source);

  const meta: { label: string; value: string }[] = [
    { label: "Date", value: current.extracted_date ?? "—" },
    { label: "Source", value: current.metadata_source || "—" },
    { label: "Size", value: formatBytes(current.file_size) },
    { label: "Resolution", value: formatResolution(info?.width, info?.height) },
  ];

  const tags = current.tags ?? [];
  const category = current.category ?? null;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-card shadow-2xl outline-none ring-1 ring-border/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground" title={name}>
              {name}
            </h2>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted",
                getStatusColor(current.status),
              )}
            >
              {getStatusLabel(current.status)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {showNav && (
              <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                {idx + 1} / {items.length}
              </span>
            )}
            {showNav && (
              <>
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={!hasPrev}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Previous file"
                >
                  <FiChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!hasNext}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Next file"
                >
                  <FiChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close preview"
            >
              <FiX className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Image area — subtle neutral background, nav arrows overlaid */}
        <div className="relative flex min-h-[200px] items-center justify-center bg-muted/40 px-12 py-5 overflow-hidden">
          {showNav && (
            <button
              type="button"
              onClick={goPrev}
              disabled={!hasPrev}
              className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground shadow-sm ring-1 ring-border transition-colors hover:bg-accent disabled:opacity-20 disabled:cursor-not-allowed"
              aria-label="Previous file"
            >
              <FiChevronLeft className="h-5 w-5" />
            </button>
          )}

          {/* key forces remount (resets loading state) on navigation */}
          <ModalImage key={current.source} path={current.source} />

          {showNav && (
            <button
              type="button"
              onClick={goNext}
              disabled={!hasNext}
              className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground shadow-sm ring-1 ring-border transition-colors hover:bg-accent disabled:opacity-20 disabled:cursor-not-allowed"
              aria-label="Next file"
            >
              <FiChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Info section */}
        <div className="min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Metadata grid */}
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">
            {meta.map((m) => (
              <div key={m.label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {m.label}
                </dt>
                <dd className="truncate font-mono text-foreground" title={m.value}>
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* AI / rule tags */}
          {(tags.length > 0 || category) && (
            <div className="space-y-2">
              {tags.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {category && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Category
                  </p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-category/10 px-2.5 py-0.5 text-[11px] font-medium text-category">
                    <FiFolder className="h-3 w-3 shrink-0" />
                    {category}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Source path */}
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Source
            </p>
            <PathActions path={current.source} />
          </div>

          {/* Destination path (if known) */}
          {current.destination && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Destination
              </p>
              <p
                className="select-all break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground"
                title={current.destination}
              >
                {current.destination}
              </p>
            </div>
          )}
        </div>

        {/* Footer: keyboard hint */}
        {showNav && (
          <p className="border-t border-border px-5 py-2 text-[11px] text-muted-foreground">
            Use ← → arrow keys or the arrows above to navigate between files.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
