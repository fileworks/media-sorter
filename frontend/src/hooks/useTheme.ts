/**
 * Syncs the `dark` class on <html> with the OS preference, with a manual
 * override that persists in localStorage and is broadcast to other tabs/instances
 * via a `storage` event so all useTheme instances stay in sync.
 */
import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "mediasort_theme";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable
  }
  return getSystemTheme();
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  // Apply on change. We deliberately do NOT persist here: an OS-sourced initial
  // theme must stay un-stored so the matchMedia listener below keeps following
  // the OS. Persistence happens only on an explicit user toggle (see `toggle`).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for OS theme changes (only when no manual override is stored).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      try {
        if (!localStorage.getItem(STORAGE_KEY)) {
          setThemeState(e.matches ? "dark" : "light");
        }
      } catch {
        setThemeState(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Sync across multiple instances / tabs via storage events.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        setThemeState(e.newValue);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Explicit user action — persist the choice (also broadcast to other tabs via
  // the `storage` event), establishing the manual override the OS listener honours.
  const toggle = () =>
    setThemeState((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });

  return { theme, toggle };
}
