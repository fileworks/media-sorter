/**
 * LogViewer — collapsible real-time log panel.
 *
 * Starts collapsed. Auto-expands when an operation starts.
 * Auto-scrolls to the bottom unless the user has scrolled up.
 *
 * Icon/color mapping keys off `level` + case-insensitive `message` substrings.
 * Each entry may carry an optional `context` object (e.g. { path, error, … }).
 * When present, `context.path` is shown dimmed below the message; `context.error`
 * is shown on error-level entries.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useLogs } from "@/hooks/useLogs";
import { formatDate } from "@/lib/dateFormatters";
import { useI18n } from "@/i18n/I18nContext";
import type { LogEntry } from "@/types/api";
import {
  FiX,
  FiXCircle,
  FiAlertTriangle,
  FiCheckCircle,
  FiInfo,
  FiChevronUp,
  FiChevronDown,
} from "react-icons/fi";

// ── Types ─────────────────────────────────────────────────────────────────────

type FilterLevel = "all" | "info" | "warnings" | "errors";

export interface LogViewerProps {
  /** True while a sort, analysis, or preview is actively running. */
  isRunning: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEntryStyle(
  level: string,
  message: string,
): { icon: React.ReactNode; colorClass: string } {
  const msg = message.toLowerCase();

  if (
    level === "error" ||
    level === "critical" ||
    msg.includes("failed") ||
    msg.includes("error") ||
    msg.includes("corrupt")
  ) {
    return {
      icon: <FiXCircle className="h-3 w-3 shrink-0 mt-0.5" />,
      colorClass: "text-error",
    };
  }

  if (
    level === "warning" ||
    msg.includes("quarantine") ||
    msg.includes("suspicious") ||
    msg.includes("skipping")
  ) {
    return {
      icon: <FiAlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />,
      colorClass: "text-warning",
    };
  }

  if (
    msg.includes("sorted") ||
    msg.includes("copied") ||
    msg.includes("moved") ||
    msg.includes("completed")
  ) {
    return {
      icon: <FiCheckCircle className="h-3 w-3 shrink-0 mt-0.5" />,
      colorClass: "text-success",
    };
  }

  return {
    icon: <FiInfo className="h-3 w-3 shrink-0 mt-0.5" />,
    colorClass: "text-info",
  };
}

/** 24-hour clock time for a log entry; falls back to the raw timestamp. */
function formatTime(timestamp: string, locale: string): string {
  return formatDate(timestamp, { type: "time-only", locale, nullPlaceholder: timestamp });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LogViewer({ isRunning }: LogViewerProps) {
  const { t, locale } = useI18n();
  const { logs, isConnected, clear } = useLogs();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Start collapsed by default — user expands it when they want detail
  const [collapsed, setCollapsed] = useState(true);
  const [filter, setFilter] = useState<FilterLevel>("all");
  const [userScrolled, setUserScrolled] = useState(false);
  // Keep technical detail out of the primary workflow until work starts or a
  // message actually exists. This avoids presenting an idle socket as an error.
  const [visible, setVisible] = useState(false);
  const prevRunningRef = useRef(false);

  // Auto-show when an operation starts — but keep it collapsed so the user
  // decides when to open it. They can expand at any time by clicking the header.
  useEffect(() => {
    if (isRunning && !prevRunningRef.current) {
      setVisible(true);
      // Do NOT auto-expand — the user controls collapse state manually.
    }
    prevRunningRef.current = isRunning;
  }, [isRunning]);

  // Also reveal if entries arrive while the panel is hidden
  useEffect(() => {
    if (logs.length > 0) setVisible(true);
  }, [logs.length]);

  // Detect manual scroll-up: pause auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    setUserScrolled(!atBottom);
  }, []);

  // Auto-scroll to bottom on new entries (unless user scrolled up)
  useEffect(() => {
    if (!collapsed && !userScrolled && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, collapsed, userScrolled]);

  // Hidden state — render nothing so the parent layout doesn't leave a gap
  if (!visible) return null;

  // ── Derived counts ─────────────────────────────────────────────────────────

  const errorCount = logs.filter((e) => e.level === "error" || e.level === "critical").length;
  const warningCount = logs.filter((e) => e.level === "warning").length;

  const filtered = logs.filter((e) => {
    switch (filter) {
      case "info":
        return e.level === "info" || e.level === "debug";
      case "warnings":
        return e.level === "warning";
      case "errors":
        return e.level === "error" || e.level === "critical";
      default:
        return true;
    }
  });

  const filterLabels: Record<FilterLevel, string> = {
    all: t("log.filter.all"),
    info: t("log.filter.info"),
    warnings:
      warningCount > 0
        ? t("log.filterCount", { label: t("log.filter.warnings"), count: warningCount })
        : t("log.filter.warnings"),
    errors:
      errorCount > 0
        ? t("log.filterCount", { label: t("log.filter.errors"), count: errorCount })
        : t("log.filter.errors"),
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shrink-0 px-6 pb-4">
      <div
        className={[
          "flex flex-col rounded-xl border border-console-border bg-console shadow-sm",
          "transition-[height] duration-200",
          collapsed ? "h-9" : "h-52",
        ].join(" ")}
      >
        {/* ── Header ── */}
        <div
          className="flex shrink-0 cursor-pointer select-none items-center justify-between border-b border-console-border px-3 py-1.5"
          onClick={() => setCollapsed((v) => !v)}
          style={{ borderBottomColor: collapsed ? "transparent" : undefined }}
        >
          {/* Left: connection dot + title + badges */}
          <div className="flex items-center gap-2">
            <span
              className={[
                "inline-block h-1.5 w-1.5 rounded-full",
                isConnected ? "bg-success" : isRunning ? "bg-error" : "bg-console-muted",
              ].join(" ")}
              aria-hidden
            />
            <span className="text-xs font-semibold text-console-foreground">{t("log.title")}</span>
            <span className="text-xs text-console-muted">({logs.length})</span>
            {errorCount > 0 && (
              <span className="flex items-center gap-0.5 rounded bg-error/15 px-1.5 py-0.5 text-xs font-medium text-error">
                <FiXCircle className="h-3 w-3" />
                {errorCount}
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                <FiAlertTriangle className="h-3 w-3" />
                {warningCount}
              </span>
            )}
          </div>

          {/* Right: filter tabs, clear, collapse, dismiss */}
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {!collapsed &&
              (["all", "info", "warnings", "errors"] as FilterLevel[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={[
                    "rounded px-2 py-0.5 text-xs transition-colors",
                    filter === f
                      ? "bg-console-border text-console-foreground"
                      : "text-console-muted hover:text-console-foreground",
                  ].join(" ")}
                >
                  {filterLabels[f]}
                </button>
              ))}

            {!collapsed && (
              <button
                type="button"
                onClick={clear}
                className="ml-1 rounded px-2 py-0.5 text-xs text-console-muted hover:text-console-foreground"
              >
                {t("log.clear")}
              </button>
            )}

            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="p-1 text-console-muted hover:text-console-foreground rounded"
              aria-label={collapsed ? t("log.expand") : t("log.collapse")}
            >
              {collapsed ? (
                <FiChevronUp className="h-3.5 w-3.5" />
              ) : (
                <FiChevronDown className="h-3.5 w-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setVisible(false)}
              className="p-1 text-console-muted hover:text-console-foreground rounded"
              aria-label={t("log.dismiss")}
            >
              <FiX className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ── Log lines ── */}
        {!collapsed && (
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs"
            onScroll={handleScroll}
          >
            {filtered.length === 0 ? (
              <p className="text-console-muted">
                {logs.length === 0 ? t("log.empty") : t("log.noMatches")}
              </p>
            ) : (
              filtered.map((entry: LogEntry, idx) => {
                const { icon, colorClass } = getEntryStyle(entry.level, entry.message);
                // Defensive: context values are typed as `unknown` and may
                // be anything (object, array, number). Only render strings.
                const rawPath = entry.context?.path;
                const ctxPath = typeof rawPath === "string" ? rawPath : undefined;
                const rawError =
                  entry.level === "error" || entry.level === "critical"
                    ? entry.context?.error
                    : undefined;
                const ctxError = typeof rawError === "string" ? rawError : undefined;
                return (
                  <div key={idx} className={`flex items-start gap-2 leading-5 ${colorClass}`}>
                    <span className="shrink-0 font-bold">{icon}</span>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="text-console-foreground">{entry.message}</span>
                      {ctxPath && (
                        <span className="block truncate text-console-muted" title={ctxPath}>
                          {ctxPath}
                        </span>
                      )}
                      {ctxError && <span className="block text-error">{ctxError}</span>}
                    </span>
                    <span className="shrink-0 text-console-muted">
                      {formatTime(entry.timestamp, locale)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
