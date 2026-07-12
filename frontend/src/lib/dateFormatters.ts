/**
 * Shared date/time formatters.
 *
 * Consolidates `formatDate` (HistoryPanel), `formatMonthYear` (AnalysisPanel),
 * and `formatTime` (LogViewer) into a single options-driven helper. Each `type`
 * preserves the exact output and locale of the call site it replaces. Invalid
 * or missing dates resolve to `nullPlaceholder` (invalid dates never render as
 * the literal string "Invalid Date").
 *
 * The `Intl.DateTimeFormat` instances are cached at module level: constructing
 * a new one per call (× 1000 log lines × every WebSocket message) was a
 * measurable source of log-viewer jank.
 */

// Module-level cached formatters for the most-used format types.
const _fmt = {
  "month-year": new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }),
  "time-only": new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }),
  "date-only": new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }),
  full: new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }),
};

export type DateFormatType = "full" | "date-only" | "time-only" | "month-year";

/**
 * Parse a value into a `Date`. A date-only string (`YYYY-MM-DD` or `YYYY-MM`)
 * is parsed by the JS engine as **UTC** midnight, so in a negative-offset
 * timezone `"2026-06-01"` would render as "May 2026" / "May 31". Build such
 * strings from local components so the displayed month/day matches the literal
 * string. Strings carrying a time component keep the engine's normal parsing.
 */
function parseValue(value: string | Date): Date {
  if (value instanceof Date) return value;
  const dateOnly = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Number(year), Number(month) - 1, day ? Number(day) : 1);
  }
  return new Date(value);
}

export interface FormatDateOptions {
  /**
   * Granularity:
   * - `"full"`       → `"Jun 1, 2026, 03:45 PM"` (default)
   * - `"date-only"`  → `"Jun 1, 2026"`
   * - `"time-only"`  → `"14:32:15"` (24-hour)
   * - `"month-year"` → `"Jun 2026"`
   */
  type?: DateFormatType;
  /** BCP 47 locale override. Defaults are chosen to match prior call sites. */
  locale?: string;
  /** Returned for nullish or unparseable input. Default `"N/A"`. */
  nullPlaceholder?: string;
}

/**
 * Format a date or ISO string for display.
 *
 * @param value - a `Date`, an ISO/parseable string, or nullish
 * @param options - granularity, locale, and placeholder
 * @returns a formatted string, or `nullPlaceholder` for missing/invalid input
 *
 * @example
 * formatDate("2026-06-01T15:45:00") // "Jun 1, 2026, 03:45 PM"
 * formatDate("2026-06-01", { type: "month-year" }) // "Jun 2026"
 * formatDate("nope", { type: "time-only", nullPlaceholder: "—" }) // "—"
 */
export function formatDate(
  value: string | Date | null | undefined,
  options: FormatDateOptions = {},
): string {
  const { type = "full", locale, nullPlaceholder = "N/A" } = options;

  if (value == null) return nullPlaceholder;
  const date = parseValue(value);
  if (isNaN(date.getTime())) return nullPlaceholder;

  // When a custom locale is requested, fall back to ad-hoc formatter.
  // The cached instances above cover the default (no locale) case.
  if (locale) {
    switch (type) {
      case "month-year":
        return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(date);
      case "time-only":
        return new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(date);
      case "date-only":
        return new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(date);
      default:
        return new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
    }
  }

  return _fmt[type].format(date);
}
