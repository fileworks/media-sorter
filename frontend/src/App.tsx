import "./index.css";
import MainPage from "@/pages/MainPage";
import { ToastProvider } from "@/context/ToastContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTheme } from "@/hooks/useTheme";

export default function App() {
  // Sync the `dark` CSS class on <html> exactly once at the app root.
  useTheme();
  return (
    <ErrorBoundary>
      <ToastProvider>
        <MainPage />
      </ToastProvider>
    </ErrorBoundary>
  );
}
