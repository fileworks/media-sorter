/**
 * One dialog, four times over.
 *
 * Every modal in the app used to reimplement the same five behaviours slightly
 * differently — one portalled and one did not, one closed on a backdrop click
 * and one only on Escape, two put `role="dialog"` on the backdrop rather than on
 * the panel. That is the kind of inconsistency a user feels without being able
 * to name: dialogs that do not dismiss the same way stop being predictable.
 *
 * So the shell owns all of it — portal, backdrop, Escape, focus trap, scroll
 * lock, sizing — and a caller supplies only the content. `ModalHeader`,
 * `ModalBody` and `ModalFooter` give every dialog the same anatomy: a titled
 * header carrying the close affordance, one scrolling body, and actions pinned
 * to the bottom where they stay reachable at any window height.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  // For a layer whose content *is* the point — a photograph being judged
  // against another. Still the same shell, so it portals, traps focus, stacks
  // and answers Escape exactly like every other dialog.
  full: "max-w-none h-[calc(100dvh-2rem)]",
};

interface ModalContextValue {
  titleId: string;
  title: string;
  titleHidden: boolean;
  onClose: () => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

function useModalContext(): ModalContextValue {
  const context = useContext(ModalContext);
  if (!context) throw new Error("Modal sub-components must be rendered inside <Modal>");
  return context;
}

/**
 * The open dialogs, innermost last.
 *
 * Two things need it. The body's scroll lock is released by the last modal to
 * close, not by the first — a preview opened from inside a compare dialog must
 * not hand scrolling back to the page underneath. And Escape must dismiss only
 * the topmost one: both listeners sit on `window`, so stopping propagation
 * cannot separate them, and without a stack one keypress closed the whole pile.
 */
const modalStack: symbol[] = [];

function useModalStack(active: boolean): { isTopmost: () => boolean } {
  const idRef = useRef<symbol | null>(null);
  if (!idRef.current) idRef.current = Symbol("modal");
  const id = idRef.current;

  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    modalStack.push(id);
    document.body.style.overflow = "hidden";
    return () => {
      const index = modalStack.lastIndexOf(id);
      if (index !== -1) modalStack.splice(index, 1);
      if (modalStack.length === 0) document.body.style.overflow = previousOverflow;
    };
  }, [active, id]);

  const isTopmost = useCallback(() => modalStack[modalStack.length - 1] === id, [id]);
  return { isTopmost };
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** The accessible name, rendered by `ModalHeader` unless `titleHidden`. */
  title: string;
  titleHidden?: boolean;
  size?: ModalSize;
  children: ReactNode;
  /** Extra panel classes, for sizing beyond `size`. */
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  titleHidden = false,
  size = "md",
  children,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const { isTopmost } = useModalStack(open);

  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopmost()) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, isTopmost]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto p-4",
        // No blur: at 2px it reads as a rendering fault rather than depth. The
        // scrim is deepened instead, which separates the panel just as well.
        "bg-foreground/65",
      )}
      // Only a press that starts *and* ends on the backdrop dismisses: a drag
      // that begins inside the panel — selecting a path, dragging the compare
      // slider — and releases outside it is not a request to close.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          // Opacity fades temporarily blend every line with the backdrop and
          // make otherwise compliant dialog text fail contrast while opening.
          "my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden",
          "rounded-2xl border border-border bg-card shadow-card outline-none",
          SIZE_CLASS[size],
          className,
        )}
      >
        <ModalContext.Provider value={{ titleId, title, titleHidden, onClose }}>
          {children}
        </ModalContext.Provider>
      </div>
    </div>,
    document.body,
  );
}

export function ModalHeader({
  children,
  actions,
}: {
  /** Content beside the title — a subtitle, a badge, a mode switch. */
  children?: ReactNode;
  /** Controls left of the close button. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const { titleId, title, titleHidden, onClose } = useModalContext();
  // `div`, not `header`/`footer`: inside a dialog those still map to the page's
  // `banner` and `contentinfo` landmarks, so an open modal reported two of each.
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3.5">
      <h2
        id={titleId}
        className={cn("min-w-0 text-sm font-semibold text-foreground", titleHidden && "sr-only")}
      >
        {title}
      </h2>
      {children}
      <span className="flex-1" />
      {actions}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FiX className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)}>{children}</div>
  );
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
      {children}
    </div>
  );
}
