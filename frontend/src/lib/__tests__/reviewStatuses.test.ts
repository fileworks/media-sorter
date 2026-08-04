import { describe, expect, it } from "vitest";

// The backend's own list, read rather than restated — the same technique as
// `reviewFolders.test.ts`, for the same reason.
import sortPlanSource from "../../../../backend/app/core/sort_plan.py?raw";
import { PLANNED_QUARANTINE_STATUSES, plannedActionOf } from "@/lib/reviewRows";
import type { PreviewItem } from "@/types/api";

/**
 * The Execute preflight subtracts what Review excluded from the plan's own
 * totals, so its arithmetic is only right while the two sides agree on which
 * statuses were counted as quarantine and which as transfers.
 *
 * They did not. `unknown_date` and `future_date` were planned as quarantine
 * actions by the backend but tallied as transfers here, so every excluded
 * undated file — and they start excluded — moved one file from the wrong
 * total. `Math.max(0, …)` then hid the result at zero rather than negative.
 */
describe("planned quarantine statuses", () => {
  function backendPlannedQuarantineStatuses(): string[] {
    const block = sortPlanSource.match(
      /PLANNED_QUARANTINE_STATUSES = frozenset\(\s*\{([\s\S]*?)\}\s*\)/,
    );
    if (!block) {
      throw new Error("PLANNED_QUARANTINE_STATUSES not found — did the backend move it?");
    }
    return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }

  it("matches the statuses the backend plans a quarantine action for", () => {
    expect([...PLANNED_QUARANTINE_STATUSES].sort()).toEqual(
      backendPlannedQuarantineStatuses().sort(),
    );
  });

  it("counts an undated file as quarantine, not as a transfer", () => {
    expect(plannedActionOf("unknown_date")).toBe("quarantine");
    expect(plannedActionOf("suspicious_date")).toBe("quarantine");
    expect(plannedActionOf("future_date")).toBe("quarantine");
    expect(plannedActionOf("sort")).toBe("transfer");
  });

  it("counts a status the backend plans nothing for as neither", () => {
    // No action is frozen into the plan for these, so excluding one takes
    // nothing off the totals the preflight is correcting.
    expect(plannedActionOf("failed")).toBe("none");
    expect(plannedActionOf("duplicate_unknown")).toBe("none");
    expect(plannedActionOf("review_only")).toBe("none");
  });

  it("classifies every status the API can send", () => {
    const statuses: PreviewItem["status"][] = [
      "sort",
      "unknown_date",
      "future_date",
      "duplicate",
      "failed",
      "suspicious_date",
      "junk",
      "already_in_destination",
      "duplicate_unknown",
      "review_only",
    ];
    for (const status of statuses) {
      expect(["transfer", "quarantine", "none"]).toContain(plannedActionOf(status));
    }
  });
});
