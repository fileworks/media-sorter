import { useState, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useMediaInfo, formatResolution } from "@/hooks/useMediaInfo";
import { Thumbnail } from "./thumbnail";

export interface HoverMeta {
  label: string;
  value: string;
}

interface MediaHoverCardProps {
  /** Absolute path of the file to thumbnail. */
  path: string;
  /** Bold title shown above the metadata (usually the basename). */
  title: string;
  /** Key/value rows shown under the thumbnail. */
  meta: HoverMeta[];
  /** The inline trigger (e.g. the filename text). */
  children: ReactNode;
  className?: string;
}

const CARD_W = 224;
// Rough height used only to decide whether to flip the card above the trigger.
const CARD_H_EST = 240;
const MARGIN = 8;

/**
 * Hover/focus card that previews a media file: a lazy thumbnail plus a few
 * metadata rows. Rendered through a portal with fixed positioning so it escapes
 * the preview list's `overflow` clipping, and flips above the trigger when it
 * would run off the bottom of the viewport.
 */
export function MediaHoverCard({ path, title, meta, children, className }: MediaHoverCardProps) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Only fetch the file's resolution once the card is actually shown.
  const { data: info } = useMediaInfo(path, coords !== null);
  const rows: HoverMeta[] =
    info && info.width && info.height
      ? [...meta, { label: "Resolution", value: formatResolution(info.width, info.height) }]
      : meta;

  const show = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = r.bottom + MARGIN;
    if (top + CARD_H_EST > window.innerHeight) {
      top = Math.max(MARGIN, r.top - CARD_H_EST - MARGIN);
    }
    let left = r.left;
    if (left + CARD_W > window.innerWidth - MARGIN) {
      left = window.innerWidth - CARD_W - MARGIN;
    }
    setCoords({ top, left: Math.max(MARGIN, left) });
  };

  const hide = () => setCoords(null);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
        className={cn(
          "cursor-help outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </span>

      {coords &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[100] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
            style={{ top: coords.top, left: coords.left, width: CARD_W }}
          >
            <Thumbnail path={path} maxPx={448} className="h-32 w-full rounded object-contain" />
            <p className="mt-2 truncate text-xs font-medium text-foreground" title={title}>
              {title}
            </p>
            <dl className="mt-1 space-y-0.5">
              {rows.map((m) => (
                <div
                  key={m.label}
                  className="flex items-baseline justify-between gap-3 text-[11px]"
                >
                  <dt className="shrink-0 text-muted-foreground">{m.label}</dt>
                  <dd className="min-w-0 truncate font-mono text-foreground">{m.value}</dd>
                </div>
              ))}
            </dl>
          </div>,
          document.body,
        )}
    </>
  );
}
