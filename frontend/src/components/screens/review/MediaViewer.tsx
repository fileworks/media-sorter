/** Full-screen media viewer built on the shared modal stack. */

import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiMaximize, FiMinus, FiPlus } from "react-icons/fi";

import { Modal, ModalFooter, ModalHeader, ModalShortcuts } from "@/components/ui/modal";
import { Tooltip } from "@/components/ui/tooltip";
import { MediaVideo } from "@/components/ui/media-video";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useI18n } from "@/i18n/I18nContext";
import { useQueuedThumbnail } from "@/lib/thumbnailQueue";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

/** Request one large image and scale it locally across zoom steps. */
const VIEWER_MAX_PX = 2048;

const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

interface MediaViewerProps {
  path: string;
  name: string;
  /** Where the run would put it, shown so enlarging never loses the plan. */
  destination: string | null;
  /** Position within the set being read, for "3 of 7". */
  position: { index: number; total: number } | null;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}

export function MediaViewer({
  path,
  name,
  destination,
  position,
  onPrevious,
  onNext,
  onClose,
}: MediaViewerProps) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const zoom = ZOOM_STEPS[zoomStep];
  const info = useMediaInfo(path);
  const isVideo = info.data?.media_type === "video";
  const canZoom = info.data?.media_type === "image";
  const effectiveZoom = canZoom ? zoom : 1;

  // Each newly opened file starts fitted to the viewport.
  useEffect(() => setZoomStep(0), [path]);

  const zoomIn = useCallback(
    () => setZoomStep((step) => Math.min(step + 1, ZOOM_STEPS.length - 1)),
    [],
  );
  const zoomOut = useCallback(() => setZoomStep((step) => Math.max(step - 1, 0)), []);

  // The modal owns Escape; `ModalShortcuts` owns the rest, and only while this
  // viewer is the dialog on top — opening it *from* the comparison dialog used
  // to leave both listening on `window`, so one arrow key moved two things.
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") onPrevious?.();
      else if (event.key === "ArrowRight") onNext?.();
      else if (canZoom && (event.key === "+" || event.key === "=")) zoomIn();
      else if (canZoom && event.key === "-") zoomOut();
      else if (canZoom && event.key === "0") setZoomStep(0);
    },
    [canZoom, onNext, onPrevious, zoomIn, zoomOut],
  );

  // Center the scrollable image after each zoom change.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || effectiveZoom === 1) return;
    frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
    frame.scrollTop = (frame.scrollHeight - frame.clientHeight) / 2;
  }, [effectiveZoom]);

  return (
    <Modal open onClose={onClose} title={name} size="full">
      <ModalShortcuts onKey={onKey} />
      <ModalHeader
        actions={
          canZoom ? (
            <>
              <ViewerButton
                label={t("review.viewer.zoomOut")}
                onClick={zoomOut}
                disabled={zoomStep === 0}
                disabledReason={t("review.viewer.alreadyFit")}
                icon={FiMinus}
              />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {zoom === 1 ? t("review.viewer.fit") : `${zoom}×`}
              </span>
              <ViewerButton
                label={t("review.viewer.zoomIn")}
                onClick={zoomIn}
                disabled={zoomStep === ZOOM_STEPS.length - 1}
                disabledReason={t("review.viewer.maximumZoom")}
                icon={FiPlus}
              />
              <ViewerButton
                label={t("review.viewer.fitToWindow")}
                onClick={() => setZoomStep(0)}
                disabled={zoomStep === 0}
                disabledReason={t("review.viewer.alreadyFit")}
                icon={FiMaximize}
              />
            </>
          ) : undefined
        }
      >
        <span className="min-w-0 truncate text-xs text-faint" title={destination ?? undefined}>
          {destination === null
            ? t("review.viewer.notPlaced")
            : t("review.viewer.goesTo", { destination })}
        </span>
      </ModalHeader>

      {/* Use a high-contrast neutral surface behind the image. */}
      <div
        ref={frameRef}
        className={cn(
          "min-h-0 flex-1 bg-foreground",
          effectiveZoom === 1
            ? "flex items-center justify-center overflow-hidden"
            : "overflow-auto",
        )}
      >
        {info.isLoading ? (
          <p role="status" className="px-6 text-center text-sm text-background/80">
            {t("review.detail.infoLoading")}
          </p>
        ) : info.isError ? (
          <div className="px-6 text-center text-sm text-background/80">
            <p role="alert">{t("review.detail.infoFailed")}</p>
            <button
              type="button"
              className="mt-3 rounded-panel border border-current px-3 py-2 font-medium"
              onClick={() => void info.refetch()}
            >
              {t("state.retry")}
            </button>
          </div>
        ) : isVideo ? (
          <div className="flex h-full w-full items-center justify-center p-4">
            <MediaVideo path={path} name={name} className="max-h-full max-w-full" />
          </div>
        ) : (
          <ViewerImage path={path} name={name} zoom={effectiveZoom} />
        )}
      </div>

      <ModalFooter>
        <div className="mr-auto flex items-center gap-2">
          <ViewerButton
            label={t("review.detail.previous")}
            onClick={() => onPrevious?.()}
            disabled={onPrevious === null}
            disabledReason={t("review.detail.noPrevious")}
            icon={FiArrowLeft}
          />
          <ViewerButton
            label={t("review.detail.next")}
            onClick={() => onNext?.()}
            disabled={onNext === null}
            disabledReason={t("review.detail.noNext")}
            icon={FiArrowRight}
          />
          {position !== null && (
            <span className="text-3xs tabular-nums text-faint">
              {t("review.viewer.position", {
                index: position.index + 1,
                total: position.total,
              })}
            </span>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

function ViewerButton({
  label,
  onClick,
  icon: Icon,
  disabled = false,
  disabledReason,
}: {
  label: string;
  onClick: () => void;
  icon: typeof FiPlus;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    // Every one of these is icon-only, so the hint is the only place the name
    // is legible to a sighted pointer user. A disabled control says why.
    <Tooltip label={disabled && disabledReason ? `${label} — ${disabledReason}` : label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-description={disabled ? disabledReason : undefined}
        className="shrink-0 rounded-panel p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** Reuse the thumbnail queue so superseded image requests are released. */
function ViewerImage({ path, name, zoom }: { path: string; name: string; zoom: number }) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { objectUrl, loading, errored, unavailable } = useQueuedThumbnail(
    api.thumbnailUrl(path, VIEWER_MAX_PX),
    wrapperRef,
  );

  if (unavailable || errored) {
    return (
      <div ref={wrapperRef} className="flex h-full w-full items-center justify-center">
        <p className="px-6 text-center text-sm text-background/80">
          {unavailable ? t("preview.noThumbnail") : t("preview.thumbnailFailed")}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "p-4",
        zoom === 1 ? "flex h-full w-full items-center justify-center" : "min-w-full",
      )}
    >
      {loading && (
        <div role="status" aria-label={t("preview.thumbnailLoading")}>
          <div
            aria-hidden
            className="h-8 w-8 animate-spin rounded-full border-2 border-background/30 border-t-background"
          />
        </div>
      )}
      {objectUrl && (
        <img
          src={objectUrl}
          alt={name}
          decoding="async"
          style={zoom === 1 ? undefined : { width: `${zoom * 100}%`, maxWidth: "none" }}
          className={cn("mx-auto", zoom === 1 && "max-h-full max-w-full object-contain")}
        />
      )}
    </div>
  );
}
