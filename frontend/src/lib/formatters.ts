/**
 * Shared display formatters — bytes, durations, and counts.
 *
 * These consolidate the five `formatBytes`, four `formatDuration`, and the
 * scattered `toLocaleString()` implementations that previously lived inside
 * individual components (see the refactoring analysis). Each function keeps the
 * historical output of its call sites; per-site differences are expressed
 * through the options objects rather than copy-pasted code.
 */

import { NULL_PLACEHOLDER } from "@/lib/constants";

// ── Bytes ───────────────────────────────────────────────────────────────────

export type ByteUnit = "B" | "KB" | "MB" | "GB" | "TB";

export interface FormatBytesOptions {
  /** Largest unit to scale up to. Default `"GB"`. */
  maxUnit?: ByteUnit;
  /** Returned for `null`/`undefined`/`<= 0`/non-finite input. Default `"—"`. */
  nullPlaceholder?: string;
  /**
   * Decimal places for fractional units. `"auto"` (default) shows 1 decimal
   * only when the value is < 10 in a unit above bytes, otherwise rounds to a
   * whole number. A fixed number applies that many decimals to KB and above
   * while bytes always render whole.
   */
  decimals?: number | "auto";
}

const BYTE_UNITS: ByteUnit[] = ["B", "KB", "MB", "GB", "TB"];

/**
 * Format a byte count as a human-readable size, e.g. `1536` → `"1.5 KB"`.
 *
 * @param bytes - the size in bytes (nullish/0/negative → `nullPlaceholder`)
 * @param options - unit cap, placeholder, and decimal-place behaviour
 * @returns a formatted string such as `"4.2 MB"` or the placeholder
 *
 * @example
 * formatBytes(1024) // "1.0 KB"
 * formatBytes(0, { nullPlaceholder: "0 B" }) // "0 B"
 * formatBytes(500 * 1024, { decimals: 1 }) // "500.0 KB"
 */
export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const { maxUnit = "GB", nullPlaceholder = NULL_PLACEHOLDER, decimals = "auto" } = options;

  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) {
    return nullPlaceholder;
  }

  const maxIdx = BYTE_UNITS.indexOf(maxUnit);
  // Clamp to [0, maxIdx]: a fractional byte count (0 < bytes < 1) yields a
  // negative log and would otherwise index BYTE_UNITS[-1] === undefined.
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), maxIdx));
  const value = bytes / Math.pow(1024, i);

  const places = decimals === "auto" ? (i > 0 && value < 10 ? 1 : 0) : i === 0 ? 0 : decimals;

  return `${places > 0 ? value.toFixed(places) : Math.round(value)} ${BYTE_UNITS[i]}`;
}

// ── Durations ───────────────────────────────────────────────────────────────

export type DurationStyle = "short" | "long" | "verbose";

export interface FormatDurationOptions {
  /**
   * Output style:
   * - `"short"`  → `"2m 30s"` (default); rolls up: `"2h 2m"`, `"1d 1h"`
   * - `"long"`   → `"2 min 30 sec"`; rolls up: `"2 hr 2 min"`, `"1 day 1 hr"`
   * - `"verbose"`→ magnitude-switching words: `"~30 seconds"` / `"~2 minutes"` /
   *   `"~2.0 hours"` / `"~1.1 days"`
   */
  style?: DurationStyle;
  /** Prefix the result with `"~"`. Default `false`. */
  approximate?: boolean;
  /** How to round the seconds component. Default `"round"`. */
  rounding?: "round" | "ceil";
  /** Returned for `null`/`undefined`/non-finite input. Default `"—"`. */
  nullPlaceholder?: string;
}

/**
 * Format a duration in seconds, e.g. `90` → `"1m 30s"`.
 *
 * @param seconds - the duration (nullish/non-finite → `nullPlaceholder`)
 * @param options - style, approximation marker, rounding, and placeholder
 * @returns a formatted string or the placeholder
 *
 * @example
 * formatDuration(90) // "1m 30s"
 * formatDuration(7320) // "2h 2m"
 * formatDuration(91290) // "1d 1h"
 * formatDuration(90, { style: "long" }) // "1 min 30 sec"
 * formatDuration(7200, { style: "verbose", approximate: true }) // "~2.0 hours"
 * formatDuration(91290, { style: "verbose" }) // "1.1 days"
 */
export function formatDuration(
  seconds: number | null | undefined,
  options: FormatDurationOptions = {},
): string {
  const {
    style = "short",
    approximate = false,
    rounding = "round",
    nullPlaceholder = NULL_PLACEHOLDER,
  } = options;

  if (seconds == null || !Number.isFinite(seconds)) {
    return nullPlaceholder;
  }

  const prefix = approximate ? "~" : "";
  const roundFn = rounding === "ceil" ? Math.ceil : Math.round;

  if (style === "verbose") {
    // Carry rounded values up a unit so we never emit "60 seconds" or
    // "60 minutes": e.g. 59.7s → "1 minutes", 3599s → "1.0 hours". Comparing the
    // rounded value (not the raw seconds) against the 60-unit boundary is what
    // prevents the off-by-one display. Long durations roll on through hours into
    // days so a multi-hour ETA never renders as "91.0 hours".
    const secs = roundFn(seconds);
    if (secs < 60) return `${prefix}${secs} seconds`;
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${prefix}${mins} minutes`;
    const hours = seconds / 3600;
    if (hours < 24) return `${prefix}${hours.toFixed(1)} hours`;
    return `${prefix}${(seconds / 86400).toFixed(1)} days`;
  }

  const long = style === "long";
  // Unit suffixes (long keeps the abbreviated, non-pluralising convention of the
  // existing "min"/"sec": "1 day", "2 hr", "1 min").
  const dayUnit = long ? " day" : "d";
  const hourUnit = long ? " hr" : "h";
  const minUnit = long ? " min" : "m";
  const secUnit = long ? " sec" : "s";

  // Round the whole duration first, then split into d/h/m/s. Rounding only the
  // smallest component lets it round up to 60 (e.g. 119.6s → "1m 60s"); rounding
  // the total avoids that — 119.6s → 120 → "2m".
  const total = roundFn(seconds);
  const components: [number, string][] = [
    [Math.floor(total / 86400), dayUnit],
    [Math.floor((total % 86400) / 3600), hourUnit],
    [Math.floor((total % 3600) / 60), minUnit],
    [total % 60, secUnit],
  ];

  // Show the most-significant non-zero unit plus the next one down, dropping a
  // trailing zero (so 120s → "2m", not "2m 0s"). All-zero → "0s".
  const top = components.findIndex(([value]) => value > 0);
  if (top === -1) return `${prefix}0${secUnit}`;
  const [topValue, topUnit] = components[top];
  const next = components[top + 1];
  if (!next || next[0] === 0) return `${prefix}${topValue}${topUnit}`;
  return `${prefix}${topValue}${topUnit} ${next[0]}${next[1]}`;
}

// ── Counts ──────────────────────────────────────────────────────────────────

/**
 * Format an integer with locale-aware thousands separators, e.g. `1234` →
 * `"1,234"`. Thin wrapper over `toLocaleString` so call sites stay consistent.
 *
 * @param value - the number to format
 * @param locale - optional BCP 47 locale; defaults to the browser locale
 */
export function formatCount(value: number, locale?: string): string {
  return value.toLocaleString(locale);
}
