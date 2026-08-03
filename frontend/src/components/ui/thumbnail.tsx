import { useRef, type ReactNode } from "react";
import { FiAlertTriangle, FiFile, FiZoomIn } from "react-icons/fi";
import { api } from "@/services/api";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";
import { useQueuedThumbnail } from "@/lib/thumbnailQueue";

/**
 * Lazily-loaded image thumbnail for a local media file. The backend renders a
 * small JPEG on demand and answers 415 where there is none. Nothing is fetched
 * until the element mounts, so this is safe to drop into hover cards.
 *
 * "There is no preview for this file" and "the preview did not load" are drawn
 * differently and worded differently. They used to be the same grey square,
 * which told a user their library was failing to load when in fact it had been
 * asked to preview a format that has no preview.
 *
 * Sizing comes from `className` (e.g. `h-32 w-full`). The wrapper inherits the
 * sizing classes; the inner `<img>` fills it with `object-contain`. A spinner
 * shows while the image loads.
 *
 * Pass `onOpen` and the whole tile becomes a button with a zoom affordance.
 * That is not decoration: a picture the user cannot click to enlarge is the
 * single most reliable way to make a review screen feel broken, and every
 * thumbnail in this app sits on a screen whose entire job is looking at files.
 *
 * `maxPx` is the longest-edge size to request from the backend. Pass roughly 2×
 * the CSS display size so the image stays crisp on HiDPI displays. Omit it to
 * keep the backend's small default (fine for tiny hover thumbnails).
 */
export function Thumbnail({
  path,
  className,
  maxPx,
  onOpen,
  openLabel,
}: {
  path: string;
  className?: string;
  maxPx?: number;
  /** Makes the thumbnail a control. Called on click and on Enter/Space. */
  onOpen?: () => void;
  /** Accessible name for that control; defaults to "Open preview of <file>". */
  openLabel?: string;
}) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { objectUrl, loading, waiting, errored, unavailable } = useQueuedThumbnail(
    api.thumbnailUrl(path, maxPx),
    wrapperRef,
  );

  const body: ReactNode = unavailable ? (
    <Tooltip label={t("preview.noThumbnail")}>
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <FiFile className="h-6 w-6 text-muted-foreground/60" aria-hidden />
        <span className="sr-only">{t("preview.noThumbnail")}</span>
      </div>
    </Tooltip>
  ) : errored ? (
    <Tooltip label={t("preview.thumbnailFailed")}>
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <FiAlertTriangle className="h-6 w-6 text-warning/70" aria-hidden />
        <span className="sr-only">{t("preview.thumbnailFailed")}</span>
      </div>
    </Tooltip>
  ) : (
    <>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
        </div>
      )}
      {/* Waiting is not loading: an off-screen tile must not animate, or a long
          list spins in every direction at once. */}
      {waiting && <div className="absolute inset-0 bg-muted" aria-hidden />}
      <img
        src={objectUrl ?? undefined}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn(
          "h-full w-full object-contain transition-opacity duration-200",
          objectUrl ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );

  if (!onOpen) {
    return (
      <div ref={wrapperRef} className={cn("relative overflow-hidden bg-muted", className)}>
        {body}
      </div>
    );
  }

  const label = openLabel ?? t("preview.openFile", { name: path.split(/[\\/]/).pop() ?? path });

  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group/thumb relative block cursor-zoom-in overflow-hidden bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          className,
        )}
      >
        <span ref={wrapperRef} className="relative block h-full w-full">
          {body}
        </span>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center bg-foreground/25 opacity-0 transition-opacity",
            "group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100",
          )}
        >
          <FiZoomIn className="h-5 w-5 text-white drop-shadow" />
        </span>
      </button>
    </Tooltip>
  );
}
