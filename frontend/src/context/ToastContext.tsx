import { useCallback, useState, type FC, type ReactNode } from "react";

import { StateView, type StateViewVariant } from "@/components/StateView";

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

  const STATE_VARIANT: Record<ToastVariant, StateViewVariant> = {
    success: "success",
    error: "error",
    info: "info",
    warning: "warning",
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto max-w-sm shadow-lg">
            <StateView variant={STATE_VARIANT[t.variant]} title={t.message} compact />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
