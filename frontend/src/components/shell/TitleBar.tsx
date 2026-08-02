/**
 * The application's own title row: what this is, what it is doing, and the
 * handful of controls that belong to the whole app rather than to a stage.
 *
 * The design mocks a full desktop window frame here, minimise/maximise/close
 * included. Those are deliberately absent: this window keeps its native
 * decorations, so drawing a second set would give the user two close buttons.
 * Everything else from the mock — the mark, the name, the run label, the
 * language pill — is here, in the same order.
 */

import type { ReactNode } from "react";
import { FiClock, FiMoon, FiSun } from "react-icons/fi";

import { AppMark } from "@/components/icons";
import { useI18n, type Locale } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export type BackendState = "ready" | "connecting" | "lost";

interface TitleBarProps {
  /** The run's one-line subtitle, e.g. "New run" or "Run in progress". */
  runLabel: string;
  backend: BackendState;
  version: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  historyCount: number;
  onOpenHistory: () => void;
  /** Indeterminate bar across the top edge while any long operation runs. */
  busy: boolean;
  children?: ReactNode;
}

const BACKEND_DOT: Record<BackendState, string> = {
  ready: "bg-success",
  connecting: "bg-warning animate-pulse",
  lost: "bg-error",
};

export function TitleBar({
  runLabel,
  backend,
  version,
  theme,
  onToggleTheme,
  locale,
  onLocaleChange,
  historyCount,
  onOpenHistory,
  busy,
  children,
}: TitleBarProps) {
  const { t } = useI18n();
  const backendLabel =
    backend === "ready"
      ? t("backend.ready")
      : backend === "lost"
        ? t("backend.lost")
        : t("backend.connecting");

  return (
    <header className="relative z-20 shrink-0 border-b border-border bg-card">
      {busy && (
        <div className="progress-indeterminate absolute inset-x-0 top-0 h-0.5" aria-hidden />
      )}
      <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-5">
        <AppMark className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight text-foreground">MediaSorter</span>
        <span className="hidden truncate text-xs text-faint sm:inline">— {runLabel}</span>
        {version && (
          <span className="hidden rounded-full bg-muted px-2 py-0.5 text-3xs font-semibold text-muted-foreground md:inline">
            v{version}
          </span>
        )}

        <div className="flex-1" />

        {children}

        <span
          className="hidden items-center gap-2 rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground md:inline-flex"
          role="status"
          title={
            backend === "ready" && version
              ? t("backend.connected", { version })
              : backendLabel
          }
        >
          <span className={cn("h-2 w-2 rounded-full", BACKEND_DOT[backend])} aria-hidden />
          {backendLabel}
        </span>

        <label className="inline-flex items-center">
          <span className="sr-only">{t("config.language.label")}</span>
          <select
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value as Locale)}
            className="cursor-pointer rounded-full border border-border bg-transparent py-1 pl-2.5 pr-6 text-2xs font-semibold uppercase text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="en">EN</option>
            <option value="de">DE</option>
          </select>
        </label>

        <button
          type="button"
          onClick={onOpenHistory}
          title={t("app.history")}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FiClock className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{t("app.history")}</span>
          {historyCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-3xs font-semibold text-foreground">
              {historyCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          title={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
          aria-label={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {theme === "dark" ? (
            <FiSun className="h-4 w-4" aria-hidden />
          ) : (
            <FiMoon className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    </header>
  );
}
