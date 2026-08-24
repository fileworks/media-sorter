/** Authenticated video playback with an honest unsupported-media fallback. */

import { useState } from "react";

import { useI18n } from "@/i18n/I18nContext";
import { useAuthorizedMedia } from "@/lib/thumbnailQueue";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";

export function MediaVideo({
  path,
  name,
  className,
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [failedObjectUrl, setFailedObjectUrl] = useState<string | null>(null);
  const { objectUrl, loading, errored, unavailable } = useAuthorizedMedia(
    api.mediaContentUrl(path),
  );
  const playbackFailed = objectUrl !== null && failedObjectUrl === objectUrl;
  if (unavailable || errored || playbackFailed) {
    return (
      <p role="status" className="px-6 py-10 text-center text-xs text-muted-foreground">
        {t("review.viewer.videoUnavailable")}
      </p>
    );
  }
  if (loading || objectUrl === null) {
    return (
      <p role="status" className="px-6 py-10 text-center text-xs text-muted-foreground">
        {t("review.viewer.videoLoading")}
      </p>
    );
  }
  return (
    <video
      className={cn("max-h-full max-w-full", className)}
      src={objectUrl}
      controls
      aria-label={name}
      onError={() => setFailedObjectUrl(objectUrl)}
    />
  );
}
