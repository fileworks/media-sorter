/**
 * A single large image from the local media API.
 *
 * Not `<img src={api.thumbnailUrl(...)}>`: the loopback API authenticates every
 * request with a capability header, and an `<img>` cannot send one — so a plain
 * src is answered with 401 and the picture never appears. This fetches through
 * the API client and hands the DOM an object URL instead.
 *
 * `Thumbnail` is the small, many-at-once counterpart; it goes through the
 * viewport-prioritised queue. This one is for images that are on screen by
 * definition — a modal hero, a difference map — where queueing adds nothing.
 */

import type { ReactNode } from "react";

import { useI18n } from "@/i18n/I18nContext";
import { useAuthorizedMedia } from "@/lib/thumbnailQueue";
import { cn } from "@/lib/utils";

interface MediaImageProps {
  /** A full media-endpoint URL, e.g. `api.thumbnailUrl(path, 1600)`. */
  src: string;
  alt: string;
  className?: string;
  /** Shown instead of the image when it cannot be rendered. */
  fallback?: ReactNode;
}

export function MediaImage({ src, alt, className, fallback }: MediaImageProps) {
  const { t } = useI18n();
  const { objectUrl, loading, errored } = useAuthorizedMedia(src);

  if (errored) {
    return (
      <>
        {fallback ?? (
          <p className="px-6 py-10 text-center text-xs text-muted-foreground">
            {t("preview.lightbox.unavailable")}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-muted-foreground" />
        </span>
      )}
      <img
        src={objectUrl ?? undefined}
        alt={alt}
        decoding="async"
        className={cn(
          "transition-opacity duration-200",
          objectUrl ? "opacity-100" : "opacity-0",
          className,
        )}
      />
    </>
  );
}
