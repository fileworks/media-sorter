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
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "full";

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  // For a dialog whose content is a table of paths. At `xl` the "goes to"
  // column wrapped a destination across three lines while a 1920-pixel display
  // sat half empty, which is the one thing a reader is there to compare.
  "2xl": "max-w-7xl",
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
  /** Whether this dialog is the one the user is actually operating. */
  topmost: boolean;
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
const modalStackListeners = new Set<() => void>();
let modalStackVersion = 0;

function publishModalStack(): void {
  modalStackVersion += 1;
  for (const listener of modalStackListeners) listener();
}

function subscribeModalStack(listener: () => void): () => void {
  modalStackListeners.add(listener);
  return () => modalStackListeners.delete(listener);
}

function modalStackSnapshot(): number {
  return modalStackVersion;
}

function useModalStack(active: boolean): { isTopmost: () => boolean; topmost: boolean } {
  const idRef = useRef<symbol | null>(null);
  if (!idRef.current) idRef.current = Symbol("modal");
  const id = idRef.current;

  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    modalStack.push(id);
    publishModalStack();
    document.body.style.overflow = "hidden";
    return () => {
      const index = modalStack.lastIndexOf(id);
      if (index !== -1) modalStack.splice(index, 1);
      publishModalStack();
      if (modalStack.length === 0) document.body.style.overflow = previousOverflow;
    };
  }, [active, id]);

  useSyncExternalStore(subscribeModalStack, modalStackSnapshot, modalStackSnapshot);
  const isTopmost = useCallback(() => modalStack[modalStack.length - 1] === id, [id]);
  return { isTopmost, topmost: isTopmost() };
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
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const previouslyOpenRef = useRef(false);
  const titleId = useId();

  if (open && !previouslyOpenRef.current) {
    restoreTargetRef.current = document.activeElement as HTMLElement | null;
  }
  previouslyOpenRef.current = open;

  const { isTopmost, topmost } = useModalStack(open);

  useFocusTrap(panelRef, open, isTopmost, restoreTargetRef.current);

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
      data-modal-layer
      aria-hidden={topmost ? undefined : true}
      inert={!topmost}
      className={cn(
        "modal-backdrop-enter fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto p-4",
        // No blur: at 2px it reads as a rendering fault rather than depth. The
        // scrim is deepened instead, which separates the panel just as well.
        "bg-foreground/65",
      )}
      // Only a press that starts *and* ends on the backdrop dismisses: a drag
      // that begins inside the panel — selecting a path, dragging the compare
      // slider — and releases outside it is not a request to close.
      onMouseDown={(event) => {
        if (topmost && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={topmost ? true : undefined}
        aria-labelledby={titleId}
        className={cn(
          // Opacity fades temporarily blend every line with the backdrop and
          // make otherwise compliant dialog text fail contrast while opening.
          "modal-panel-enter my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden",
          "rounded-panel border border-border bg-card shadow-card outline-none",
          SIZE_CLASS[size],
          className,
        )}
      >
        <ModalContext.Provider value={{ titleId, title, titleHidden, onClose, topmost }}>
          {children}
        </ModalContext.Provider>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The header row: identity on the left, controls on the right, one line.
 *
 * It used to wrap. A dialog titled with a filename is the common case here —
 * the media viewer names the file it is showing — and a long one pushed zoom,
 * fit and close onto a second row, so the controls moved depending on what you
 * had opened. The row is now `flex-nowrap`: the identity group is the only
 * thing that shrinks, the controls keep their place at the right edge, and an
 * over-long name is truncated with the whole of it still in the accessible
 * name and on hover.
 */
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
    <div className="flex flex-nowrap items-center gap-x-2 border-b border-border px-3 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-x-2">
        <h2
          id={titleId}
          // CSS truncation only: the full string stays in the DOM, so the
          // accessible name is never the shortened one.
          title={title}
          className={cn(
            "min-w-0 truncate text-sm font-semibold text-foreground",
            titleHidden && "sr-only",
          )}
        >
          {title}
        </h2>
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-x-1">{actions}</div>}
      <Tooltip label={t("common.close")}>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FiX className="h-4 w-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * Key bindings that belong to one dialog, and only while it is on top.
 *
 * Rendered *inside* a `Modal` so it can read the stack the modal registered
 * itself in. The handler is skipped while another dialog is above this one,
 * and while the key would otherwise be typed into a control — the same
 * exclusion Review's queue shortcuts use, kept in one place so two surfaces
 * cannot disagree about what counts as typing.
 */
export function ModalShortcuts({ onKey }: { onKey: (event: KeyboardEvent) => void }) {
  const { topmost } = useModalContext();
  const handlerRef = useRef(onKey);
  handlerRef.current = onKey;

  useEffect(() => {
    if (!topmost) return;
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, select, button, a, video, audio, [contenteditable='true'], [role='slider']",
        )
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      handlerRef.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [topmost]);

  return null;
}

export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto p-3", className)}>{children}</div>;
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-3">
      {children}
    </div>
  );
}
