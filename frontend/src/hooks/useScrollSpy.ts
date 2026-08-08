import { useCallback, useEffect, useState } from "react";

/** The nearest ancestor that actually scrolls, or null if that is the page. */
function scrollParentOf(element: Element): Element | null {
  let node = element.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Which of `ids` is currently the one being read.
 *
 * "Being read" is the last anchor that has crossed the top of the scrolling
 * region, not the one most visible: on a settings page a person scrolls to a
 * heading and then reads downwards, so the section that owns the top edge is
 * the section they are in. An `IntersectionObserver` answers a different
 * question — which boxes overlap the viewport — and gets the highlight wrong
 * for a group whose rows are taller than the window.
 *
 * `offset` is measured from the top of that scrolling region rather than from
 * the top of the window, because in this app the region starts below a title
 * bar and a stepper — measuring from the viewport marked a row as "not reached
 * yet" while it sat pinned at the top of its own container.
 *
 * The listener is registered in the capture phase so it also sees scrolls
 * inside nested containers, which do not bubble.
 */
export function useScrollSpy(ids: string[], offset = 96): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(" ");

  const measure = useCallback(() => {
    const list = key ? key.split(" ") : [];
    let baseline: number | null = null;
    let current: string | null = null;
    let first: string | null = null;

    for (const id of list) {
      const element = document.getElementById(id);
      if (!element) continue;
      if (baseline === null) {
        const container = scrollParentOf(element);
        baseline = container ? container.getBoundingClientRect().top : 0;
      }
      if (!first) first = id;
      if (element.getBoundingClientRect().top - baseline <= offset) current = id;
    }
    setActive(current ?? first);
  }, [key, offset]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    schedule();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [measure]);

  return active;
}
