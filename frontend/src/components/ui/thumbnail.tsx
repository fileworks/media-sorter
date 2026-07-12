import { useState } from "react";
import { FiFile } from "react-icons/fi";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

/**
 * Lazily-loaded image thumbnail for a local media file. The backend renders a
 * small JPEG on demand; videos and unreadable files respond 415, which trips
 * `onError` and shows a neutral placeholder instead. Nothing is fetched until
 * the element mounts, so this is safe to drop into hover cards.
 *
 * Sizing comes from `className` (e.g. `h-32 w-full`). The wrapper div inherits
 * the sizing classes; the inner `<img>` fills it with `object-contain`. A
 * pulse skeleton is shown while the image loads.
 *
 * `maxPx` is the longest-edge size to request from the backend. Pass roughly 2×
 * the CSS display size so the image stays crisp on HiDPI displays. Omit it to
 * keep the backend's small default (fine for tiny hover thumbnails).
 */
export function Thumbnail({
  path,
  className,
  maxPx,
}: {
  path: string;
  className?: string;
  maxPx?: number;
}) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (errored) {
    return (
      <div
        className={cn("flex items-center justify-center text-muted-foreground bg-muted", className)}
        aria-hidden
      >
        <FiFile className="h-6 w-6 text-muted-foreground/60" />
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
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
          "h-full w-full object-contain transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
