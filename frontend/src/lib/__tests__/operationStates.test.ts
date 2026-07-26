import { describe, expect, it } from "vitest";
import type { AnalysisResult, PreviewResult } from "@/services/api";
import { canStartSort, getAnalysisGate, partialScanWarning } from "@/lib/operationStates";

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    total_files: 3,
    total_size_bytes: 300,
    by_type: { jpeg: 3 },
    date_range: { earliest: null, latest: null, no_date_estimate: 0 },
    disk_space: {
      source_size_bytes: 300,
      destination_free_bytes: 1_000,
      sufficient: true,
      mode: "copy",
      free_space_known: true,
    },
    excluded_files: 0,
    estimated_duration_seconds: 1,
    warnings: [],
    partial: false,
    issues: [],
    ...overrides,
  };
}

describe("operation states", () => {
  it("keeps preview disabled for unavailable, empty, and insufficient analyses", () => {
    expect(getAnalysisGate(null, false, "Source folder is unavailable.")).toMatchObject({
      canPreview: false,
      reason: "Analysis failed — retry first",
    });
    expect(getAnalysisGate(analysis({ total_files: 0 }), false, null)).toEqual({
      canPreview: false,
      empty: true,
      reason: "No supported files matched the current scan settings",
    });
    expect(
      getAnalysisGate(
        analysis({ disk_space: { ...analysis().disk_space, sufficient: false } }),
        false,
        null,
      ).canPreview,
    ).toBe(false);
  });

  it("allows preview after a non-empty successful analysis", () => {
    expect(getAnalysisGate(analysis(), false, null)).toEqual({
      canPreview: true,
      empty: false,
      reason: null,
    });
  });

  it("keeps sort disabled for an empty preview", () => {
    const preview: PreviewResult = {
      items: [],
      stats: {
        total: 0,
        will_sort: 0,
        will_fail: 0,
        will_quarantine_unknown: 0,
        will_quarantine_future: 0,
        will_skip_duplicate: 0,
        will_quarantine_junk: 0,
        will_skip_already_in_destination: 0,
        uncategorized: 0,
      },
      partial: false,
      issues: [],
    };
    expect(canStartSort(preview)).toBe(false);
    expect(canStartSort({ ...preview, stats: { ...preview.stats, total: 1 } })).toBe(true);
  });

  it("formats a concise partial traversal warning", () => {
    expect(partialScanWarning("Preview", 2)).toBe(
      "Preview is partial: 2 inaccessible path(s) were skipped.",
    );
  });
});
