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
      colorClass: "text-red-400",
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
      colorClass: "text-yellow-400",
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
      colorClass: "text-green-400",
    };
  }

  return {
    icon: <FiInfo className="h-3 w-3 shrink-0 mt-0.5" />,
    colorClass: "text-blue-400",
  };
}

/** 24-hour clock time for a log entry; falls back to the raw timestamp. */
function formatTime(timestamp: string): string {
  return formatDate(timestamp, { type: "time-only", nullPlaceholder: timestamp });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LogViewer({ isRunning }: LogViewerProps) {
  const { logs, isConnected, clear } = useLogs();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Start collapsed by default — user expands it when they want detail
  const [collapsed, setCollapsed] = useState(true);
  const [filter, setFilter] = useState<FilterLevel>("all");
  const [userScrolled, setUserScrolled] = useState(false);
  // Visible from the start so the user can always open the log
  const [visible, setVisible] = useState(true);
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
    all: "All",
    info: "Info",
    warnings: warningCount > 0 ? `Warnings (${warningCount})` : "Warnings",
    errors: errorCount > 0 ? `Errors (${errorCount})` : "Errors",
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shrink-0 px-6 pb-4">
      <div
        className={[
          "flex flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-sm",
          "transition-[height] duration-200",
          collapsed ? "h-9" : "h-52",
        ].join(" ")}
      >
        {/* ── Header ── */}
        <div
          className="flex shrink-0 cursor-pointer select-none items-center justify-between border-b border-gray-700 px-3 py-1.5"
          onClick={() => setCollapsed((v) => !v)}
          style={{ borderBottomColor: collapsed ? "transparent" : undefined }}
        >
          {/* Left: connection dot + title + badges */}
          <div className="flex items-center gap-2">
            <span
              className={[
                "inline-block h-1.5 w-1.5 rounded-full",
                isConnected ? "bg-green-400" : "bg-red-400",
              ].join(" ")}
            />
            <span className="text-xs font-semibold text-gray-200">Live Log</span>
            <span className="text-xs text-gray-500">({logs.length})</span>
            {errorCount > 0 && (
              <span className="flex items-center gap-0.5 rounded bg-red-900/60 px-1.5 py-0.5 text-xs font-medium text-red-400">
                <FiXCircle className="h-3 w-3" />
                {errorCount}
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-0.5 rounded bg-yellow-900/60 px-1.5 py-0.5 text-xs font-medium text-yellow-400">
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
                      ? "bg-gray-600 text-gray-100"
                      : "text-gray-500 hover:text-gray-200",
                  ].join(" ")}
                >
                  {filterLabels[f]}
                </button>
              ))}

            {!collapsed && (
              <button
                type="button"
                onClick={clear}
                className="ml-1 rounded px-2 py-0.5 text-xs text-gray-500 hover:text-gray-200"
              >
                Clear
              </button>
            )}

            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="p-1 text-gray-400 hover:text-gray-200 rounded"
              aria-label={collapsed ? "Expand log panel" : "Collapse log panel"}
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
              className="p-1 text-gray-400 hover:text-gray-200 rounded"
              aria-label="Dismiss log panel"
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
              <p className="text-gray-600">
                {logs.length === 0 ? "No log entries yet…" : "No entries match the current filter."}
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
                      <span className="text-gray-200">{entry.message}</span>
                      {ctxPath && (
                        <span className="block truncate text-gray-500" title={ctxPath}>
                          {ctxPath}
                        </span>
                      )}
                      {ctxError && <span className="block text-red-500">{ctxError}</span>}
                    </span>
                    <span className="shrink-0 text-gray-600">{formatTime(entry.timestamp)}</span>
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
