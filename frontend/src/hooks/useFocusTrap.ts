import { useEffect, useRef, type RefObject } from "react";

/**
 * Only `button` excluded `[disabled]`, so a disabled input, select or textarea
 * counted as a tab stop. The trap then cycled focus onto a control the browser
 * will not focus, and the keyboard user's Tab appeared to do nothing.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Trap Tab focus inside `ref` while `active` (WCAG 2.1 modal behaviour):
 * moves focus into the container on activation, cycles Tab/Shift+Tab within
 * it, and restores focus to the previously focused element on release.
 * The container needs `tabIndex={-1}` so it can receive initial focus.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const focusables = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // offsetParent is null for display:none descendants — skip them.
        (f) => f.offsetParent !== null,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      } else if (current && !ref.current.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus();
    };
  }, [ref, active]);
}
