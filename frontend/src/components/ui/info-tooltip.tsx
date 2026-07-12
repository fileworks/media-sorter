/**
 * A small "?" button that shows a popover with help text when clicked.
 * Used next to every config option label.
 *
 * The popover is rendered in a portal so it (a) is never clipped by a scrolling
 * config section and (b) stays fully readable even when its container is dimmed
 * (`opacity`). The trigger sets `pointer-events-auto` so help stays clickable
 * even while the surrounding options are locked during a computation — the user
 * can always read what an option does, they just can't change it mid-run.
 */
import * as React from "react";
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface InfoTooltipProps {
  content: React.ReactNode; // can include <code>, <strong>, examples
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

const POPOVER_WIDTH = 288; // w-72
const GAP = 8; // mb-2 / mt-2 equivalent
const MARGIN = 8; // viewport edge clamp

export function InfoTooltip({ content, side = "top", className }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top: number;
    let left: number;
    switch (side) {
      case "bottom":
        top = r.bottom + GAP;
        left = r.left;
        break;
      case "left":
        top = r.top;
        left = r.left - POPOVER_WIDTH - GAP;
        break;
      case "right":
        top = r.top;
        left = r.right + GAP;
        break;
      case "top":
      default:
        // Place above; the popover height is unknown until painted, so anchor by
        // its bottom edge using a transform (translateY(-100%)) below.
        top = r.top - GAP;
        left = r.left;
        break;
    }
    // Clamp horizontally to the viewport.
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - POPOVER_WIDTH - MARGIN));
    setCoords({ top, left });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  // Close on outside click, Escape, scroll, or resize.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(t) &&
        popoverRef.current &&
        !popoverRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <span className={cn("pointer-events-auto relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          "text-[10px] font-bold leading-none",
          "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          open && "bg-accent text-accent-foreground",
        )}
        aria-label="Help"
        aria-expanded={open}
      >
        ?
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              width: POPOVER_WIDTH,
              transform: side === "top" ? "translateY(-100%)" : undefined,
            }}
            className={cn(
              "pointer-events-auto z-[100] rounded-lg border border-border bg-popover p-3",
              "text-xs leading-relaxed text-popover-foreground shadow-lg",
              "animate-fade-in",
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
