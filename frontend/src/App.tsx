import "./index.css";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import MainPage from "@/pages/MainPage";
import { ToastProvider } from "@/context/ToastContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTheme } from "@/hooks/useTheme";
import { isTauri } from "@/lib/utils";

export default function App() {
  // Sync the `dark` CSS class on <html> exactly once at the app root.
  useTheme();
  useEffect(() => {
    if (isTauri) {
      // Release verification uses this native acknowledgement to prove the
      // bundled React shell mounted in the packaged WebView. It is a no-op
      // beyond a log marker during normal launches.
      void invoke("frontend_ready").catch(() => undefined);
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
