/**
 * The app's tooltip, replacing the browser's.
 *
 * A native `title` is a different shape, a different colour and a different
 * delay on every platform, never appears for keyboard users, and cannot be
 * dismissed — so a window full of them reads as a window full of accidents.
 * This one is themed, opens on hover *and* on focus, closes on Escape, and is
 * portalled so a card with `overflow: hidden` cannot clip it.
 *
 * It also names its trigger: an icon-only button wrapped in a tooltip gets the
 * label as its accessible name unless it already has one, so the visible hint
 * and the announced name cannot drift apart. The bubble itself is hidden from
 * assistive tech, because it would otherwise say the same thing twice.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

const OPEN_DELAY = 350;
const GAP = 8;
const MARGIN = 8;

export type TooltipSide = "top" | "bottom";

interface TooltipProps {
  /** The hint. Also becomes the trigger's accessible name when it has none. */
  label: ReactNode;
  side?: TooltipSide;
  /** A single focusable element — a button, a link, a control. */
  children: ReactElement<{ "aria-label"?: string; "aria-labelledby"?: string }>;
}

export function Tooltip({ label, side = "top", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>(0);

  const show = useCallback((immediate: boolean) => {
    window.clearTimeout(timerRef.current);
    if (immediate) setOpen(true);
    else timerRef.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  }, []);

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setOpen(false);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapperRef.current?.firstElementChild ?? wrapperRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const anchor = trigger.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const top = side === "top" ? anchor.top - size.height - GAP : anchor.bottom + GAP;
    const left = anchor.left + anchor.width / 2 - size.width / 2;
    setCoords({
      // Flip rather than run off the top edge; clamp rather than off the sides.
      top: top < MARGIN ? anchor.bottom + GAP : top,
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - size.width - MARGIN)),
    });
  }, [open, side, label]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [hide, open]);

  if (!isValidElement(children)) return children;

  const named = Boolean(children.props["aria-label"] ?? children.props["aria-labelledby"]);
  const trigger =
    named || typeof label !== "string"
      ? children
      : cloneElement(children, { "aria-label": label });

  return (
    <>
      <span
        ref={wrapperRef}
        className="contents"
        onPointerEnter={(event) => event.pointerType === "mouse" && show(false)}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={() => show(true)}
        onBlur={hide}
      >
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            aria-hidden
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              // Measured on the first paint, placed on the second; keep it out
              // of sight until it has somewhere to be.
              visibility: coords ? "visible" : "hidden",
            }}
            className={cn(
              "z-[200] max-w-[18rem] rounded-lg border border-border bg-popover px-2.5 py-1.5",
              "text-2xs leading-snug text-popover-foreground shadow-card",
              "animate-fade-in pointer-events-none",
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
