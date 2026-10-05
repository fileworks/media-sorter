import "./index.css";
import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainPage from "@/pages/MainPage";
import { ToastProvider } from "@/context/ToastContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTheme } from "@/hooks/useTheme";
import { isTauri } from "@/lib/utils";
import { verifyMediaRendering } from "@/lib/mediaRendering";

export default function App() {
  // Sync the `dark` CSS class on <html> exactly once at the app root.
  useTheme();
  useEffect(() => {
    if (isTauri) {
      void invoke("frontend_mounted").catch(() => undefined);
    }
  }, []);
  const onReady = useCallback(() => {
    if (!isTauri) return;
    // Native smoke readiness includes initial settings/session restoration,
    // followed by actual authenticated image rendering under the packaged CSP.
    void verifyMediaRendering()
      .then(() => invoke("frontend_ready"))
      .catch(() => invoke("frontend_failure").catch(() => undefined));
  }, []);
  return (
    <ErrorBoundary>
      <ToastProvider>
        <MainPage onReady={onReady} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
