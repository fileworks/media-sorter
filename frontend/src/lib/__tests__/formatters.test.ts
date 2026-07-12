import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration, formatCount } from "@/lib/formatters";

describe("formatBytes", () => {
  it("returns the placeholder for nullish / non-positive / non-finite input", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
  });

  it("honours a custom nullPlaceholder (e.g. '0 B' for disk readouts)", () => {
    expect(formatBytes(0, { nullPlaceholder: "0 B" })).toBe("0 B");
    expect(formatBytes(null, { nullPlaceholder: "0 B" })).toBe("0 B");
  });

  it("formats standard ranges with auto decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("rounds (no decimal) once a unit value reaches 10", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });

  it("caps at maxUnit", () => {
    // Default cap is GB.
    expect(formatBytes(1024 ** 4)).toBe("1024 GB");
    // TB allowed when requested.
    expect(formatBytes(5 * 1024 ** 4, { maxUnit: "TB" })).toBe("5.0 TB");
  });

  it("applies a fixed decimal count to fractional units but keeps bytes whole", () => {
    expect(formatBytes(500 * 1024, { decimals: 1 })).toBe("500.0 KB");
    expect(formatBytes(512, { decimals: 1 })).toBe("512 B");
    expect(formatBytes(1024, { decimals: 1, nullPlaceholder: "0 B" })).toBe("1.0 KB");
  });
});

describe("formatDuration", () => {
  it("returns the placeholder for nullish / non-finite input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });

  it("short style (default): compact m/s", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(120)).toBe("2m");
  });

  it("short style: rolls up through hours and days, top 2 components", () => {
    expect(formatDuration(150)).toBe("2m 30s");
    expect(formatDuration(3599)).toBe("59m 59s");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(7320)).toBe("2h 2m");
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(91290)).toBe("1d 1h"); // 1d 1h 21m 30s → top 2
  });

  it("long style: spelled-out min/sec", () => {
    expect(formatDuration(45, { style: "long" })).toBe("45 sec");
    expect(formatDuration(90, { style: "long" })).toBe("1 min 30 sec");
    expect(formatDuration(120, { style: "long" })).toBe("2 min");
  });

  it("long style: rolls up through hours and days", () => {
    expect(formatDuration(7320, { style: "long" })).toBe("2 hr 2 min");
    expect(formatDuration(91290, { style: "long" })).toBe("1 day 1 hr");
  });

  it("approximate + ceil rounding (live-progress tone)", () => {
    const opts = { style: "long", approximate: true, rounding: "ceil" } as const;
    expect(formatDuration(30.2, opts)).toBe("~31 sec");
    expect(formatDuration(90.5, opts)).toBe("~1 min 31 sec");
    expect(formatDuration(120, opts)).toBe("~2 min");
  });

  it("verbose style: magnitude-switching words", () => {
    const opts = { style: "verbose", approximate: true } as const;
    expect(formatDuration(30, opts)).toBe("~30 seconds");
    expect(formatDuration(120, opts)).toBe("~2 minutes");
    expect(formatDuration(7200, opts)).toBe("~2.0 hours");
    expect(formatDuration(45, { style: "verbose" })).toBe("45 seconds");
  });

  it("verbose style: carries up at unit boundaries (never '60 seconds'/'60 minutes')", () => {
    const v = { style: "verbose" } as const;
    expect(formatDuration(59.7, v)).toBe("1 minutes"); // rounds to 60s → carries to minutes
    expect(formatDuration(3570, v)).toBe("1.0 hours"); // 59.5 min → carries to hours
    expect(formatDuration(3599, v)).toBe("1.0 hours"); // just under an hour
  });

  it("verbose style: rolls hours into a days tier", () => {
    const v = { style: "verbose" } as const;
    expect(formatDuration(86400, v)).toBe("1.0 days");
    expect(formatDuration(91290, v)).toBe("1.1 days");
  });
});

describe("formatCount", () => {
  it("groups thousands for an explicit locale", () => {
    expect(formatCount(0, "en-US")).toBe("0");
    expect(formatCount(1234, "en-US")).toBe("1,234");
    expect(formatCount(1234567, "en-US")).toBe("1,234,567");
  });

  it("defaults to the runtime locale (matches toLocaleString)", () => {
    expect(formatCount(98765)).toBe((98765).toLocaleString());
  });
});
