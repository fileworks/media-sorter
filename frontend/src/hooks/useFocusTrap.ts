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

const ALWAYS_HANDLE = () => true;

/**
 * Trap Tab focus inside `ref` while `active` (WCAG 2.1 modal behaviour):
 * moves focus into the container on activation, cycles Tab/Shift+Tab within
 * it, and restores focus to the previously focused element on release.
 * The container needs `tabIndex={-1}` so it can receive initial focus.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  shouldHandle: () => boolean = ALWAYS_HANDLE,
  restoreTarget?: HTMLElement | null,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = restoreTarget ?? (document.activeElement as HTMLElement | null);
    // A parent trap may re-evaluate when a child layer closes. If focus has
    // already been restored to the child's exact trigger inside that parent,
    // keep it there instead of replacing it with the parent panel itself.
    if (shouldHandle() && ref.current !== null && !ref.current.contains(document.activeElement)) {
      ref.current.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current || !shouldHandle()) return;
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
      const restore = restoreRef.current;
      if (restore === null) return;
      // While a nested layer is being removed, its trigger still sits inside
      // the parent's inert subtree. Browsers correctly refuse that synchronous
      // focus call. Retry in the next microtask, after React has made the
      // parent topmost again; ordinary non-nested traps still restore now.
      if (restore.closest("[inert]")) {
        queueMicrotask(() => {
          if (restore.isConnected) restore.focus();
        });
      } else {
        restore.focus();
      }
    };
  }, [ref, active, restoreTarget, shouldHandle]);
}
