import { useCallback, useState, type FC, type ReactNode } from "react";

import { StateView, type StateViewVariant } from "@/components/StateView";

import { ToastContext, type ToastVariant } from "./toast-context";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

let _idCounter = 0;

const STATE_VARIANT: Record<ToastVariant, StateViewVariant> = {
  success: "success",
  error: "error",
  info: "info",
  warning: "warning",
};

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

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Above the dialogs on purpose: a toast raised by an action taken inside
          a modal has to be visible from inside that modal. Full width on a
          narrow window, a column in the corner once there is room for one. */}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[300] flex flex-col items-end gap-2 sm:left-auto sm:right-4">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto w-full max-w-sm shadow-card">
            <StateView variant={STATE_VARIANT[t.variant]} title={t.message} compact />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
