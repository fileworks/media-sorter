/**
 * One modal for every media inspection: single, or a synchronized pair.
 *
 * It is a layered state over whatever is underneath — the list keeps its frozen
 * order, its filters, its selection, and its scroll position, and closing puts
 * focus back on the row that opened it. Navigation walks the frozen order, so
 * Next can never reach something the list would not.
 *
 * Media loads through bounded thumbnails; the original is an explicit request.
 * Both are superseded by a token so a slow response for an item the user has
 * already left is discarded rather than rendered late.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/i18n/I18nContext";
import { getBasename } from "@/lib/pathUtils";
import {
  IDENTITY_VIEWPORT,
  close as closeModal,
  comparisonAvailable,
  keyAction,
  navigation,
  panBy,
  presentation,
  requestOriginal,
  step,
  transform,
  zoomBy,
  type MediaRef,
  type ModalState,
  type Viewport,
} from "@/lib/mediaModal";
import { api } from "@/services/api";

interface MediaModalProps {
  state: ModalState;
  /** Resolves an id from the frozen order to something renderable. */
  resolve: (id: string) => MediaRef | null;
  /** Facts and planned outcome, rendered beside the media. */
  details?: (ref: MediaRef) => React.ReactNode;
  onChange: (state: ModalState) => void;
  onClose: (restore: ReturnType<typeof closeModal>) => void;
  /** For pair mode: which item the primary should be compared against. */
  partnerFor?: (id: string) => string | null;
}

function Pane({
  reference,
  viewport,
  original,
  label,
}: {
  reference: MediaRef;
  viewport: Viewport;
  original: boolean;
  label: string;
}) {
  const [decodeFailed, setDecodeFailed] = useState(false);
  const view = presentation(reference, decodeFailed);

  useEffect(() => setDecodeFailed(false), [reference.id, original]);

  return (
    <figure className="min-w-0 space-y-2">
      <div className="flex h-[46vh] items-center justify-center overflow-hidden rounded-lg bg-black/40">
        {view.renderable ? (
          <img
            src={api.thumbnailUrl(reference.path, original ? 4096 : 1200)}
            alt={`${label} — ${getBasename(reference.path)}`}
            onError={() => setDecodeFailed(true)}
            style={{ transform: transform(viewport), transformOrigin: "center" }}
            className="max-h-full max-w-full object-contain transition-transform"
            loading="lazy"
          />
        ) : (
          <p className="px-6 text-center text-xs text-muted-foreground">{view.fallback}</p>
        )}
      </div>
      <figcaption className="truncate text-xs text-muted-foreground" title={reference.path}>
        {label} · {getBasename(reference.path)}
      </figcaption>
    </figure>
  );
}

export function MediaModal({
  state,
  resolve,
  details,
  onChange,
  onClose,
  partnerFor,
}: MediaModalProps) {
  const { t } = useI18n();
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [difference, setDifference] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const primary = resolve(state.primaryId);
  const partnerId = state.secondaryId ?? partnerFor?.(state.primaryId) ?? null;
  const secondary = partnerId ? resolve(partnerId) : null;
  const nav = navigation(state);

  const move = useCallback(
    (direction: -1 | 1) => {
      setViewport(IDENTITY_VIEWPORT);
      setDifference(false);
      onChange(step(state, direction));
    },
    [state, onChange],
  );

  const dismiss = useCallback(() => onClose(closeModal(state)), [state, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction(event.key)?.action;
      if (!action) return;
      event.preventDefault();
      if (action === "close") dismiss();
      if (action === "previous" && nav.hasPrevious) move(-1);
      if (action === "next" && nav.hasNext) move(1);
      if (action === "zoom-in") setViewport((current) => zoomBy(current, 1.4));
      if (action === "zoom-out") setViewport((current) => zoomBy(current, 1 / 1.4));
      if (action === "reset") setViewport(IDENTITY_VIEWPORT);
      if (action === "toggle-difference" && secondary) setDifference((on) => !on);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, move, nav.hasPrevious, nav.hasNext, secondary]);

  if (primary === null) return null;

  const canCompare = comparisonAvailable(state.context.origin, secondary !== null);
  const showPair = state.mode === "pair" && secondary !== null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={showPair ? "Compare media" : "Preview media"}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-5xl flex-col gap-4 overflow-auto rounded-xl border border-border bg-card p-5 outline-none"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              {getBasename(primary.path)}
            </h2>
            <p className="text-xs text-muted-foreground">
              {nav.position} of {nav.total} · {state.context.origin}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-border px-3 py-1 text-sm"
          >
            {t("common.close", undefined, "Close")}
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setViewport((current) => zoomBy(current, 1.4))}
            className="rounded-lg border border-border px-2 py-1"
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={() => setViewport((current) => zoomBy(current, 1 / 1.4))}
            className="rounded-lg border border-border px-2 py-1"
          >
            Zoom out
          </button>
          <button
            type="button"
            onClick={() => setViewport(IDENTITY_VIEWPORT)}
            className="rounded-lg border border-border px-2 py-1"
          >
            Fit
          </button>
          {["←", "→", "↑", "↓"].map((arrow, index) => (
            <button
              key={arrow}
              type="button"
              aria-label={`Pan ${arrow}`}
              disabled={viewport.zoom === 1}
              onClick={() =>
                setViewport((current) =>
                  panBy(
                    current,
                    index === 0 ? 0.1 : index === 1 ? -0.1 : 0,
                    index === 2 ? 0.1 : index === 3 ? -0.1 : 0,
                  ),
                )
              }
              className="rounded-lg border border-border px-2 py-1 disabled:opacity-40"
            >
              {arrow}
            </button>
          ))}
          {canCompare && (
            <button
              type="button"
              onClick={() => setDifference((on) => !on)}
              aria-pressed={difference}
              className={`rounded-lg border px-2 py-1 ${
                difference ? "border-primary text-primary" : "border-border"
              }`}
            >
              Difference
            </button>
          )}
          {!state.originalRequested && (
            <button
              type="button"
              onClick={() => onChange(requestOriginal(state))}
              className="rounded-lg border border-border px-2 py-1"
            >
              Load original
            </button>
          )}
        </div>

        {difference && secondary ? (
          <img
            src={api.diffUrl(primary.path, secondary.path, 1200)}
            alt="Difference between the two files"
            className="max-h-[50vh] w-full rounded-lg object-contain"
            onError={() => setDifference(false)}
          />
        ) : (
          <div className={showPair ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : ""}>
            <Pane
              reference={primary}
              viewport={viewport}
              original={state.originalRequested}
              label={showPair ? primary.label ?? "This file" : "Preview"}
            />
            {showPair && secondary && (
              <Pane
                reference={secondary}
                viewport={viewport}
                original={state.originalRequested}
                label={secondary.label ?? "Compared with"}
              />
            )}
          </div>
        )}

        {details && <div className="text-xs text-muted-foreground">{details(primary)}</div>}

        <nav className="flex items-center justify-between">
          <button
            type="button"
            disabled={!nav.hasPrevious}
            onClick={() => move(-1)}
            className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-40"
          >
            {t("common.previous", undefined, "Previous")}
          </button>
          <span className="text-xs text-muted-foreground">
            {nav.position} / {nav.total}
          </span>
          <button
            type="button"
            disabled={!nav.hasNext}
            onClick={() => move(1)}
            className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-40"
          >
            {t("common.next", undefined, "Next")}
          </button>
        </nav>
      </div>
    </div>,
    document.body,
  );
}
