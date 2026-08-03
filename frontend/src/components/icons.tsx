/**
 * The marks and glyphs the design draws itself, rather than borrowing.
 *
 * Everything here follows one geometry — a 48-unit box, 2-unit strokes, round
 * caps and joins, no fills — which is the same construction Feather (`react-icons/fi`,
 * used everywhere else in the app) is built on. That is deliberate: the product
 * mark and the interface icons have to read as one family, and matching the
 * stroke system is what does that, not matching a shape.
 *
 * Colour comes from the theme, never from a literal. The frame and the folder
 * take the ink colours; only the arrow — the gesture the whole product family
 * shares — takes the accent.
 */

import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The product mark: media arriving into an ordered folder.
 *
 * The static twins of this live in `public/icon.svg` (light-only, for the
 * favicon and docs) and `src-tauri/icons/icon.svg` (optically thickened, for
 * the OS bundle). This one flips with the theme, so keep the three in step.
 */
export function AppMark({
  className,
  title,
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      <rect x="1.5" y="1.5" width="45" height="45" rx="12" className="fill-muted stroke-border" />
      <path
        d="M10 36V20a2 2 0 012-2h7l3 3h14a2 2 0 012 2v13a2 2 0 01-2 2H12a2 2 0 01-2-2z"
        className="stroke-foreground"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 8v7M20.5 11.5L24 15l3.5-3.5"
        className="stroke-brand"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A padlock, for the one thing in Review that cannot be acted on: a file that
 * lives in a reference root. It reads as protection rather than as a denial,
 * which is the whole point of drawing it at all.
 */
export function ReferenceLockIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    >
      <rect x="1.5" y="4.5" width="7" height="4.5" rx="1" />
      <path d="M3 4.5V3a2 2 0 014 0v1.5" />
    </svg>
  );
}

/** The two-headed arrow the design uses for "compare these copies". */
export function CompareIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M2 5.5h12M11 2.5l3 3-3 3" />
      <path d="M14 10.5H2M5 13.5l-3-3 3-3" />
    </svg>
  );
}
