import { describe, expect, it } from "vitest";

import {
  boundHistory,
  filterHistory,
  redactRoot,
  summarizeEntry,
  totalBytes,
  type HistoryEntry,
} from "@/lib/operationHistory";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    operation_id: "op1",
    profile_id: "organize-only",
    started_at: "2026-07-20T10:00:00Z",
    finished_at: "2026-07-20T10:30:00Z",
    outcome: "completed",
    roots: ["/Users/someone/Pictures/Library"],
    counts: {
      verified_success: 120,
      warnings: 0,
      skipped: 0,
      quarantined: 0,
      failed: 0,
      unresolved: 0,
    },
    bytes_written: 1_000,
    report_id: "rep1",
    recovery_state: "none",
    ...overrides,
  };
}

describe("filterHistory", () => {
  it("finds runs that need attention", () => {
    const entries = [
      entry(),
      entry({ operation_id: "op2", counts: { ...entry().counts, failed: 3 } }),
      entry({ operation_id: "op3", recovery_state: "required" }),
      entry({ operation_id: "op4", outcome: null, finished_at: null }),
    ];

    expect(filterHistory(entries, "problems").map((e) => e.operation_id)).toEqual(["op2"]);
    expect(filterHistory(entries, "recovery").map((e) => e.operation_id)).toEqual(["op3"]);
    expect(filterHistory(entries, "running").map((e) => e.operation_id)).toEqual(["op4"]);
    expect(filterHistory(entries, "all")).toHaveLength(4);
  });
});

describe("boundHistory", () => {
  it("puts the newest run first and keeps the list bounded", () => {
    const entries = [
      entry({ operation_id: "old", started_at: "2026-01-01T00:00:00Z" }),
      entry({ operation_id: "new", started_at: "2026-07-01T00:00:00Z" }),
      entry({ operation_id: "middle", started_at: "2026-04-01T00:00:00Z" }),
    ];

    expect(boundHistory(entries, 2).map((e) => e.operation_id)).toEqual(["new", "middle"]);
  });
});

describe("redactRoot", () => {
  it("keeps enough to recognise the library and drops the user's name", () => {
    expect(redactRoot("/Users/someone/Pictures/Library")).toBe("…/Pictures/Library");
    expect(redactRoot("D:\\Photos\\2019")).toBe("…/Photos/2019");
  });

  it("leaves a short root alone rather than redacting it to nothing", () => {
    expect(redactRoot("/Volumes")).toBe("/Volumes");
  });
});

describe("summarizeEntry", () => {
  it("shows only the counts that are non-zero", () => {
    const summary = summarizeEntry(
      entry({ counts: { ...entry().counts, quarantined: 4, skipped: 2 } }),
    );

    expect(summary.facts.map((fact) => fact.label)).toEqual([
      "Organized",
      "Skipped",
      "Quarantined",
    ]);
  });

  it("gives a partial run concrete next steps", () => {
    const summary = summarizeEntry(
      entry({ outcome: "partial", counts: { ...entry().counts, unresolved: 2 } }),
    );

    expect(summary.nextSteps.join(" ")).toMatch(/unresolved/i);
  });

  it("states that quarantined originals were not deleted", () => {
    const summary = summarizeEntry(entry({ counts: { ...entry().counts, quarantined: 9 } }));

    expect(summary.nextSteps.join(" ")).toMatch(/nothing was deleted/i);
    expect(summary.links.map((link) => link.kind)).toContain("quarantine");
  });

  it("blocks nothing but says so when recovery is required", () => {
    const summary = summarizeEntry(entry({ recovery_state: "required" }));

    expect(summary.nextSteps[0]).toMatch(/interrupted/i);
  });

  it("always offers a way to reach the correlated logs", () => {
    expect(summarizeEntry(entry()).links.map((link) => link.kind)).toContain("logs");
  });

  it("labels a run with no outcome as running", () => {
    expect(summarizeEntry(entry({ outcome: null })).headline).toBe("Running");
  });
});

describe("totalBytes", () => {
  it("adds up what was actually written", () => {
    expect(totalBytes([entry(), entry({ bytes_written: 500 })])).toBe(1_500);
  });
});
