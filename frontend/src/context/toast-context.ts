import { createContext, useContext } from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

// Lives in its own (non-component) module so the provider file can export only a
// component — that keeps React Fast Refresh happy (eslint react-refresh rule).
export const ToastContext = createContext<ToastContextValue>({
  toast: () => undefined,
});

export const useToast = () => useContext(ToastContext);
