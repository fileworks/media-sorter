/**
 * The app's tooltip, replacing the browser's.
 *
 * A native `title` is a different shape, a different colour and a different
 * delay on every platform, never appears for keyboard users, and cannot be
 * dismissed — so a window full of them reads as a window full of accidents.
 * This one is themed, opens on hover *and* on focus, closes on Escape, and is
 * portalled so a card with `overflow: hidden` cannot clip it.
 *
 * Unnamed icon actions use the hint as their accessible name. Named actions
 * keep their name and receive an additional description when the hint explains
 * more. The visual bubble is hidden from assistive tech to avoid repetition.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

const OPEN_DELAY = 350;
const CLOSE_DELAY = 150;
const GAP = 8;
const MARGIN = 8;

export type TooltipSide = "top" | "bottom";

interface TooltipProps {
  /** The hint. Also becomes the trigger's accessible name when it has none. */
  label: ReactNode;
  side?: TooltipSide;
  /** A single focusable element — a button, a link, a control. */
  children: ReactElement<{
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    children?: ReactNode;
  }>;
}

function readableText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(readableText).join("");
  if (isValidElement<{ children?: ReactNode; "aria-hidden"?: boolean | "true" | "false" }>(node)) {
    if (node.props["aria-hidden"] === true || node.props["aria-hidden"] === "true") return "";
    return readableText(node.props.children);
  }
  return "";
}

export function Tooltip({ label, side = "top", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>(0);
  const focusedRef = useRef(false);
  const hoveredRef = useRef(false);
  const dismissedRef = useRef(false);
  const descriptionId = useId();

  const show = useCallback((immediate: boolean) => {
    window.clearTimeout(timerRef.current);
    if (dismissedRef.current) return;
    if (immediate) setOpen(true);
    else timerRef.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  }, []);

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setOpen(false);
    setCoords(null);
  }, []);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(timerRef.current);
    if (!focusedRef.current && !hoveredRef.current) {
      timerRef.current = window.setTimeout(hide, CLOSE_DELAY);
    }
  }, [hide]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    const onRestore = (event: Event) => {
      if (!(event.target instanceof Node) || !wrapperRef.current?.contains(event.target)) return;
      hoveredRef.current = false;
      dismissedRef.current = true;
      hide();
    };
    document.addEventListener("mediasorter:restore-focus", onRestore);
    return () => document.removeEventListener("mediasorter:restore-focus", onRestore);
  }, [hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapperRef.current?.firstElementChild ?? wrapperRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const initialSize = bubble.getBoundingClientRect();
    // CSS zoom scales client rectangles, but fixed positioning still uses CSS
    // coordinates. Native browser zoom already supplies CSS viewport units.
    const scale = bubble.offsetWidth ? initialSize.width / bubble.offsetWidth || 1 : 1;
    const viewportWidth = window.innerWidth / scale;
    const viewportHeight = window.innerHeight / scale;
    bubble.style.maxWidth = `min(18rem, ${Math.max(1, viewportWidth - 2 * MARGIN)}px)`;
    bubble.style.maxHeight = `${Math.max(1, viewportHeight - 2 * MARGIN)}px`;
    const rect = trigger.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const width = size.width / scale;
    const height = size.height / scale;
    const above = rect.top / scale - height - GAP;
    const below = rect.bottom / scale + GAP;
    const preferred = side === "top" ? above : below;
    const alternative = side === "top" ? below : above;
    const fits = (top: number) => top >= MARGIN && top + height <= viewportHeight - MARGIN;
    const top = fits(preferred) ? preferred : fits(alternative) ? alternative : preferred;
    const left = (rect.left + rect.width / 2) / scale - width / 2;
    setCoords({
      top: Math.max(MARGIN, Math.min(top, viewportHeight - height - MARGIN)),
      left: Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN)),
    });
  }, [open, side, label]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissedRef.current = true;
      hide();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && bubbleRef.current?.contains(event.target)) return;
      hide();
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Node)) return;
      if (wrapperRef.current?.contains(event.target) || bubbleRef.current?.contains(event.target))
        return;
      hide();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [hide, open]);

  if (!isValidElement(children)) return children;

  const labelText = readableText(label).trim();
  const name = children.props["aria-label"] ?? readableText(children.props.children).trim();
  const named = Boolean(name || children.props["aria-labelledby"]);
  const described = named && !name.includes(labelText);
  const trigger = cloneElement(children, {
    ...(!named && labelText ? { "aria-label": labelText } : {}),
    ...(described
      ? {
          "aria-describedby": [children.props["aria-describedby"], descriptionId]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
  });

  return (
    <>
      <span
        ref={wrapperRef}
        className="contents"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          hoveredRef.current = true;
          const trigger = wrapperRef.current?.firstElementChild;
          if (trigger instanceof HTMLElement) delete trigger.dataset.restoredFocus;
          dismissedRef.current = false;
          show(false);
        }}
        onPointerLeave={() => {
          hoveredRef.current = false;
          scheduleClose();
        }}
        onKeyDown={() => {
          const trigger = wrapperRef.current?.firstElementChild;
          if (trigger instanceof HTMLElement) delete trigger.dataset.restoredFocus;
        }}
        onPointerDown={() => {
          dismissedRef.current = true;
          hide();
        }}
        onFocus={() => {
          focusedRef.current = true;
          show(true);
        }}
        onBlur={() => {
          focusedRef.current = false;
          dismissedRef.current = false;
          const trigger = wrapperRef.current?.firstElementChild;
          if (trigger instanceof HTMLElement) delete trigger.dataset.restoredFocus;
          scheduleClose();
        }}
      >
        {trigger}
        {described && (
          <span id={descriptionId} className="sr-only">
            {label}
          </span>
        )}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            data-tooltip
            aria-hidden
            onPointerEnter={() => {
              hoveredRef.current = true;
              window.clearTimeout(timerRef.current);
            }}
            onPointerLeave={() => {
              hoveredRef.current = false;
              scheduleClose();
            }}
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              // Measured on the first paint, placed on the second; keep it out
              // of sight until it has somewhere to be.
              visibility: coords ? "visible" : "hidden",
            }}
            className={cn(
              "z-[200] max-w-[18rem] rounded-panel border border-border bg-popover px-3 py-2",
              "overflow-y-auto break-words text-2xs leading-snug text-popover-foreground shadow-card",
              // Opacity fades blend the text with the page and briefly take
              // this small copy below AA contrast as the bubble appears.
            )}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A tooltip whose trigger is text rather than a control. */
export function TooltipText({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
        {children}
      </span>
    </Tooltip>
  );
}
