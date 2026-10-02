import { useEffect, useRef, useState } from "react";

/**
 * Animate a number up to `target` (from 0 on mount, or from the previous value
 * on change) using an ease-out curve. Respects `prefers-reduced-motion` by
 * jumping straight to the target.
 */
export function useCountUp(target: number, duration = 500): number {
  const [value, setValue] = useState(0);
  // Track the *currently displayed* value so mid-flight target changes animate
  // forward from where the number actually is, not from the previous target.
  const displayedRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Cancel any in-flight animation before starting a new one.
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (reduce || displayedRef.current === target) {
      displayedRef.current = target;
      setValue(target);
      return;
    }

    const from = displayedRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const next = Math.round(from + (target - from) * eased);
      displayedRef.current = next;
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}
