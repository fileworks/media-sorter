import { useEffect, useState } from "react";

interface ViewportBudget {
  /** Pixels above and below the region: chrome, headers, the footer rail. */
  reserved: number;
  min: number;
  max?: number;
}

/**
 * How tall a scrolling region may be, given the window it is in.
 *
 * The windowed lists need a number rather than a CSS length — the virtualiser
 * computes the visible range from it — and a hard-coded one is wrong at both
 * ends: 520px leaves half a 1440×900 window empty, and overflows a short
 * laptop window into a page that scrolls a list that scrolls. Deriving it from
 * the live window height keeps one scroll region doing the work at any size.
 */
export function useViewportBudget({ reserved, min, max = Infinity }: ViewportBudget): number {
  const compute = () =>
    typeof window === "undefined"
      ? min
      : Math.round(Math.min(max, Math.max(min, window.innerHeight - reserved)));

  const [height, setHeight] = useState(compute);

  useEffect(() => {
    const measure = () => setHeight(compute);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `compute` closes over the three numbers, which are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserved, min, max]);

  return height;
}
