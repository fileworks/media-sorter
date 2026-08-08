/**
 * One photograph, as large as the screen allows.
 *
 * `Thumbnail` has carried an `onOpen` prop with a zoom affordance since it was
 * written and never had a caller, so nothing on a screen whose entire job is
 * looking at photographs could actually enlarge one. Deciding between two copies
 * of the same picture at 80 pixels is not deciding; it is guessing.
 *
 * Built on the shared dialog shell rather than beside it. The first draft
 * portalled, trapped focus and answered Escape for itself — and
 * `interactionContracts` rejected it, correctly: a layer that dismissed
 * differently from every other layer is the inconsistency the dialog work was
 * done to remove. The shell also gives it the modal *stack*, which is what makes
 * one Escape close the viewer and leave the detail view beneath it open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiMaximize, FiMinus, FiPlus } from "react-icons/fi";

import { Modal, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";
import { useQueuedThumbnail } from "@/lib/thumbnailQueue";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

/**
 * The largest edge the backend will render. Requesting it once and scaling in
 * the browser keeps magnification instant and costs one image rather than one
 * per zoom step.
 */
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

  // A new file is shown at fit-to-window: carrying a 4× magnification of the
  // previous picture onto this one lands the reader somewhere they did not
  // choose, on a photograph they have not seen yet.
  useEffect(() => setZoomStep(0), [path]);

  const zoomIn = useCallback(
    () => setZoomStep((step) => Math.min(step + 1, ZOOM_STEPS.length - 1)),
    [],
  );
  const zoomOut = useCallback(() => setZoomStep((step) => Math.max(step - 1, 0)), []);

  // Escape belongs to the shell. These do not, and a typing target must keep
  // its own arrow keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") onPrevious?.();
      else if (event.key === "ArrowRight") onNext?.();
      else if (event.key === "+" || event.key === "=") zoomIn();
      else if (event.key === "-") zoomOut();
      else if (event.key === "0") setZoomStep(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onPrevious, zoomIn, zoomOut]);

  // Panning is scrolling: the frame is a scroll container and the image is
  // simply larger than it. That gets keyboard scrolling, momentum and
  // touch-drag for free, where a transform-based pan gets none of them.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || zoom === 1) return;
    frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
    frame.scrollTop = (frame.scrollHeight - frame.clientHeight) / 2;
  }, [zoom]);

  return (
    <Modal open onClose={onClose} title={name} size="full">
      <ModalHeader
        actions={
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
        }
      >
        <span className="min-w-0 truncate text-xs text-faint" title={destination ?? undefined}>
          {destination === null
            ? t("review.viewer.notPlaced")
            : t("review.viewer.goesTo", { destination })}
        </span>
      </ModalHeader>

      {/* A deep surface under the picture rather than the card's own: judging a
          photograph against a light panel misreads its exposure. */}
      <div
        ref={frameRef}
        className={cn(
          "min-h-0 flex-1 bg-foreground",
          zoom === 1 ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
        )}
      >
        <ViewerImage path={path} name={name} zoom={zoom} />
      </div>

      <ModalFooter>
        <div className="mr-auto flex items-center gap-1.5">
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-description={disabled ? disabledReason : undefined}
      className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

/**
 * The picture itself, through the same queue every other preview uses.
 *
 * Going through `useQueuedThumbnail` rather than a bare `<img src>` is what
 * releases the decoded image on close and abandons a superseded request when the
 * reader moves on — a viewer that leaked one full-size bitmap per file navigated
 * would be the worst offender in the application.
 */
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
