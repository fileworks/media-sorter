import "./index.css";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainPage from "@/pages/MainPage";
import { ToastProvider } from "@/context/ToastContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTheme } from "@/hooks/useTheme";
import { isTauri } from "@/lib/utils";
import { api } from "@/services/api";
import { verifyMediaRendering } from "@/lib/mediaRendering";

export default function App() {
  // Sync the `dark` CSS class on <html> exactly once at the app root.
  useTheme();
  useEffect(() => {
    if (isTauri) {
      void invoke("frontend_mounted").catch(() => undefined);
      // A mounted loading screen is useful immediately, but release smoke
      // must also prove readiness and actual image rendering under the CSP.
      void api.whenReady().then(
        () =>
          verifyMediaRendering()
            .then(() => invoke("frontend_ready"))
            .catch(() => invoke("frontend_failure").catch(() => undefined)),
        // The launcher owns the native recovery dialog for backend failures.
        () => undefined,
      );
    }
  }, []);
  return (
    <ErrorBoundary>
      <ToastProvider>
        <MainPage />
      </ToastProvider>
    </ErrorBoundary>
  );
}
