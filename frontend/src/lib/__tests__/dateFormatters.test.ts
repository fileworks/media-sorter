import { describe, it, expect } from "vitest";
import { formatDate } from "@/lib/dateFormatters";

// Dates are built from local components (not parsed from strings) so the
// assertions are independent of the machine timezone.

describe("formatDate", () => {
  it("returns the placeholder for nullish input", () => {
    expect(formatDate(null)).toBe("N/A");
    expect(formatDate(undefined)).toBe("N/A");
  });

  it("returns the placeholder for an unparseable string", () => {
    expect(formatDate("not-a-date")).toBe("N/A");
    expect(formatDate("not-a-date", { nullPlaceholder: "—" })).toBe("—");
  });

  it("honours a custom placeholder, e.g. '' for the analysis date-range", () => {
    expect(formatDate(null, { type: "month-year", nullPlaceholder: "" })).toBe("");
  });

  it("month-year", () => {
    expect(formatDate(new Date(2026, 5, 15), { type: "month-year" })).toBe("Jun 2026");
  });

  it("time-only (24-hour)", () => {
    expect(formatDate(new Date(2026, 5, 1, 14, 32, 15), { type: "time-only" })).toBe("14:32:15");
  });

  it("time-only falls back to the raw timestamp on invalid input", () => {
    expect(formatDate("nope", { type: "time-only", nullPlaceholder: "nope" })).toBe("nope");
  });

  it("full datetime", () => {
    const out = formatDate(new Date(2026, 5, 1, 15, 45), { type: "full", locale: "en-US" });
    // Match the stable date portion + 24h-free time prefix; avoid asserting the
    // AM/PM separator, which varies (regular space vs U+202F) across ICU builds.
    expect(out).toMatch(/^Jun 1, 2026, 0?3:45/);
  });

  it("accepts a Date instance or an ISO string equivalently", () => {
    const fromString = formatDate("2026-06-15T12:00:00", { type: "month-year" });
    const fromDate = formatDate(new Date(2026, 5, 15, 12, 0, 0), { type: "month-year" });
    expect(fromString).toBe(fromDate);
    expect(fromString).toBe("Jun 2026");
  });

  it("treats a date-only string as local, not UTC (no timezone day/month shift)", () => {
    // "2026-06-01" parsed as UTC midnight would render as "May 2026" / "May 31"
    // in negative-offset timezones; it must reflect the literal date everywhere.
    expect(formatDate("2026-06-01", { type: "month-year" })).toBe("Jun 2026");
    expect(formatDate("2026-06", { type: "month-year" })).toBe("Jun 2026");
    expect(formatDate("2026-06-01", { type: "date-only", locale: "en-US" })).toBe("Jun 1, 2026");
  });
});
