/**
 * Preview and compare as *layered states*, never as a stage of their own.
 *
 * Opening a modal must not disturb what is underneath it: the frozen result
 * order, the filters, the selection, the scroll position, and any pending plan
 * decisions all survive open → navigate → close. Navigation follows the order
 * the list was frozen at rather than recomputing one, so Next never lands
 * somewhere the user cannot get back from.
 *
 * The other half is resources. A superseded proxy request is ignored rather than
 * rendered late, and decoded buffers are released on close, because a comparison
 * modal is the easiest place in this application to leak a few hundred megabytes.
 */

export type ModalMode = "single" | "pair";

export type MediaOrigin =
  | "organization"
  | "exact"
  | "similar"
  | "validation"
  | "issues"
  | "quarantine"
  | "report";

export interface MediaRef {
  id: string;
  path: string;
  /** False when the file is known to be gone — a report row, an expired item. */
  available: boolean;
  /** Why it is unavailable, when it is. */
  unavailableReason?: string;
  label?: string;
}

export interface ModalContext {
  origin: MediaOrigin;
  /** The frozen result order this modal navigates. */
  order: string[];
  /** Restored exactly on close. */
  restore: { selectionId: string | null; scrollTop: number; focusId: string | null };
}

export interface ModalState {
  mode: ModalMode;
  primaryId: string;
  /** The comparison partner in pair mode — a keeper, a representative, or a pick. */
  secondaryId: string | null;
  context: ModalContext;
  /** Monotonic token; a response for an older token is discarded. */
  requestToken: number;
  /** True once the user asked for the original rather than a bounded proxy. */
  originalRequested: boolean;
}

export function openSingle(id: string, context: ModalContext): ModalState {
  return {
    mode: "single",
    primaryId: id,
    secondaryId: null,
    context,
    requestToken: 1,
    originalRequested: false,
  };
}

export function openPair(id: string, partnerId: string, context: ModalContext): ModalState {
  return {
    mode: "pair",
    primaryId: id,
    secondaryId: partnerId,
    context,
    requestToken: 1,
    originalRequested: false,
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

export interface Navigation {
  hasPrevious: boolean;
  hasNext: boolean;
  position: number;
  total: number;
}

export function navigation(state: ModalState): Navigation {
  const index = state.context.order.indexOf(state.primaryId);
  return {
    hasPrevious: index > 0,
    hasNext: index >= 0 && index < state.context.order.length - 1,
    position: index + 1,
    total: state.context.order.length,
  };
}

/**
 * Step through the frozen order.
 *
 * Every step bumps the request token, which is what makes an in-flight proxy or
 * original request for the previous item irrelevant instead of late.
 */
export function step(state: ModalState, direction: -1 | 1): ModalState {
  const index = state.context.order.indexOf(state.primaryId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.context.order.length) {
    return state;
  }
  return {
    ...state,
    primaryId: state.context.order[target],
    // A pair follows its primary: the partner is re-derived by the caller from
    // the new item's keeper or representative.
    secondaryId: state.mode === "pair" ? null : null,
    requestToken: state.requestToken + 1,
    originalRequested: false,
  };
}

export function withPartner(state: ModalState, partnerId: string | null): ModalState {
  return { ...state, mode: partnerId ? "pair" : "single", secondaryId: partnerId };
}

export function requestOriginal(state: ModalState): ModalState {
  return { ...state, requestToken: state.requestToken + 1, originalRequested: true };
}

/** Whether a response still matters, or arrived after the user moved on. */
export function isCurrent(state: ModalState, token: number): boolean {
  return token === state.requestToken;
}

// ── Presentation ─────────────────────────────────────────────────────────────

export interface MediaPresentation {
  renderable: boolean;
  /** What to show instead, when the media cannot be rendered. */
  fallback: string | null;
  /** Always available, even when the media is not. */
  showFacts: boolean;
  showRevealAction: boolean;
}

/**
 * What a modal shows for one reference.
 *
 * Unavailable media never disables inspection: the recorded facts, the planned
 * outcome, and a reveal-in-folder action stay, because "we cannot draw it" is
 * not the same as "we know nothing about it".
 */
export function presentation(ref: MediaRef, decodeFailed = false): MediaPresentation {
  if (!ref.available) {
    return {
      renderable: false,
      fallback:
        ref.unavailableReason ??
        "This file is no longer where it was recorded. Its details are kept below.",
      showFacts: true,
      showRevealAction: true,
    };
  }
  if (decodeFailed) {
    return {
      renderable: false,
      fallback: "This file could not be displayed. Its details are kept below.",
      showFacts: true,
      showRevealAction: true,
    };
  }
  return { renderable: true, fallback: null, showFacts: true, showRevealAction: true };
}

/** Whether Compare should be offered at all for this origin. */
export function comparisonAvailable(origin: MediaOrigin, hasPartner: boolean): boolean {
  if (origin === "quarantine" || origin === "report") return false;
  return hasPartner;
}

/** Actions the modal may offer, given where it was opened from. */
export function modalActions(origin: MediaOrigin): string[] {
  switch (origin) {
    case "exact":
    case "similar":
      return ["keep", "quarantine", "skip", "reveal"];
    case "quarantine":
      return ["restore", "reveal"];
    case "report":
      return ["reveal"];
    default:
      return ["reveal"];
  }
}

// ── Pan and zoom ─────────────────────────────────────────────────────────────

export interface Viewport {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, offsetX: 0, offsetY: 0 };

/** Bounded on both ends: a zoom nobody can undo is a trap, not a feature. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export function zoomBy(viewport: Viewport, factor: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor));
  if (zoom === MIN_ZOOM) return IDENTITY_VIEWPORT;
  return { ...viewport, zoom };
}

/**
 * Pan, clamped so the image cannot be dragged off screen entirely.
 *
 * The bound is derived from the zoom: at 1× there is nowhere to pan, and at 8×
 * the edges stop exactly where the image does.
 */
export function panBy(viewport: Viewport, deltaX: number, deltaY: number): Viewport {
  const limit = (viewport.zoom - 1) / 2;
  return {
    ...viewport,
    offsetX: Math.min(limit, Math.max(-limit, viewport.offsetX + deltaX)),
    offsetY: Math.min(limit, Math.max(-limit, viewport.offsetY + deltaY)),
  };
}

/** Both panes of a comparison share one viewport — that is what synchronises them. */
export function transform(viewport: Viewport): string {
  return `scale(${viewport.zoom}) translate(${viewport.offsetX * 100}%, ${viewport.offsetY * 100}%)`;
}

// ── Closing ──────────────────────────────────────────────────────────────────

export interface RestoreTarget {
  selectionId: string | null;
  scrollTop: number;
  focusId: string | null;
  /** Ids whose decoded media should be released. */
  release: string[];
}

/**
 * What closing restores, and what it frees.
 *
 * Focus returns to the row the modal was opened from, not to the top of the
 * document — losing focus position is what makes a keyboard user start over.
 */
export function close(state: ModalState): RestoreTarget {
  return {
    selectionId: state.context.restore.selectionId,
    scrollTop: state.context.restore.scrollTop,
    focusId: state.context.restore.focusId ?? state.context.restore.selectionId,
    release: [state.primaryId, state.secondaryId].filter((id): id is string => id !== null),
  };
}

export interface KeyAction {
  action: "close" | "previous" | "next" | "zoom-in" | "zoom-out" | "reset" | "toggle-difference";
}

/** The keyboard map, so it is testable and identical everywhere. */
export function keyAction(key: string): KeyAction | null {
  switch (key) {
    case "Escape":
      return { action: "close" };
    case "ArrowLeft":
      return { action: "previous" };
    case "ArrowRight":
      return { action: "next" };
    case "+":
    case "=":
      return { action: "zoom-in" };
    case "-":
      return { action: "zoom-out" };
    case "0":
      return { action: "reset" };
    case "d":
    case "D":
      return { action: "toggle-difference" };
    default:
      return null;
  }
}
