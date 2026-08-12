/**
 * The marks and glyphs the design draws itself, rather than borrowing.
 *
 * Everything here follows one geometry — a 32-unit box, 1.9-unit strokes, round
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
 * The static twins of this live in `public/icon.svg` (tight favicon artwork)
 * and `src-tauri/icons/icon.svg` (the same mark on a padded OS tile). This one
 * flips with the theme, so keep the geometry in step with both.
 */
export function AppMark({
  className,
  title,
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      <path
        d="M4.6 10.8a2.2 2.2 0 0 1 2.2-2.2h4.9l2.5 2.9h11.1a2.2 2.2 0 0 1 2.2 2.2v9.9a2.2 2.2 0 0 1-2.2 2.2H6.8a2.2 2.2 0 0 1-2.2-2.2z"
        className="stroke-foreground"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 15.2v6.2m-2.8-2.8 2.8 2.8 2.8-2.8"
        className="stroke-brand"
        strokeWidth={1.9}
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
