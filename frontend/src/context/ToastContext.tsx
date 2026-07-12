import { useCallback, useState, type FC, type ReactNode } from "react";

import { ToastContext, type ToastVariant } from "./toast-context";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

let _idCounter = 0;

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = ++_idCounter;
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      variant === "error" ? 6000 : 4000,
    );
  }, []);

  // Card surface + coloured accent edge: token-based and readable in both
  // themes (the raw solid-colour backgrounds failed contrast in dark mode).
  const VARIANT_CLASSES: Record<ToastVariant, string> = {
    success: "border-l-success",
    error: "border-l-error",
    info: "border-l-info",
    warning: "border-l-warning",
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={[
              "pointer-events-auto max-w-sm rounded-lg border border-border border-l-4 bg-card px-4 py-3 text-sm text-card-foreground shadow-lg",
              VARIANT_CLASSES[t.variant],
            ].join(" ")}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
