import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { I18nProvider, storedLocale, translate } from "@/i18n/I18nContext";

// ── Error boundary ────────────────────────────────────────────────────────────

/** Colours for the crash screen, chosen without touching the stylesheet.
 *
 * This boundary renders when the app has already failed, so it must not depend
 * on Tailwind, the design tokens, or the `.dark` class — any of which may be
 * part of what broke. That is why these are inline literals rather than tokens.
 *
 * It still has to respect the user's theme: the previous version hardcoded a
 * white background, so a dark-mode user got a full-screen white flash at the
 * worst possible moment. `matchMedia` is read directly for the same reason the
 * styles are inline.
 *
 * The action colour is #2563eb rather than #3b82f6: white on the lighter blue
 * measures 3.68:1, under the 4.5:1 WCAG AA floor. This one is 5.17:1. Same hue,
 * and the button is the only way out of a crash screen, so it is the last place
 * to leave text hard to read.
 */
function crashPalette() {
  const dark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { background: "#1a1614", heading: "#f2ede9", body: "#a8a09a", action: "#2563eb" }
    : { background: "#fff", heading: "#1a1614", body: "#666", action: "#2563eb" };
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const palette = crashPalette();
      return (
        <div
          style={{
            display: "flex",
            height: "100vh",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            textAlign: "center",
            background: palette.background,
            color: palette.heading,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: "28rem" }}>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.75rem" }}>
              {translate(storedLocale(), "app.crashed")}
            </h1>
            <p style={{ fontSize: "0.875rem", color: palette.body, marginBottom: "1.25rem" }}>
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "0.375rem",
                background: palette.action,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              {translate(storedLocale(), "app.reload")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// ── Mount ─────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
