import { describe, expect, it } from "vitest";
import { NON_QUARANTINING_PREVIEW_STATUSES, PREVIEW_STATUSES } from "@/lib/reviewStatuses";
import contract from "../../../../contracts/review-statuses.json";

/**
 * The frontend half of the preview-status parity contract (A-06).
 *
 * The backend's `PLANNED_QUARANTINE_STATUSES` answers "does this file go to a
 * review folder?". The frontend vocabulary is that set *plus* four statuses that
 * deliberately do not quarantine — so the relation to assert is **subset**, not
 * equality. The last time these drifted, `suspicious_date` was previewed into
 * `_undated/` while the plan authorized nothing, and the run failed the same way
 * on every retry (documented at `backend/app/core/sort_plan.py`).
 *
 * The artifact is imported, not restated. Restating either vocabulary inside
 * this file would make the test pass by construction, which is exactly the
 * failure mode it exists to prevent.
 */

describe("preview status parity with the backend", () => {
  it("reads a contract in the shape this test was written against", () => {
    expect(contract.format_version).toBe(2);
  });

  it("carries every status the backend sends to a review folder", () => {
    for (const status of contract.planned_quarantine_statuses) {
      expect(PREVIEW_STATUSES).toContain(status);
    }
  });

  it("adds exactly the four reviewed non-quarantining statuses and no others", () => {
    const quarantining = new Set(contract.planned_quarantine_statuses);
    const extras = PREVIEW_STATUSES.filter((status) => !quarantining.has(status));

    expect([...extras].sort()).toEqual([
      "duplicate_unknown",
      "keep_in_place",
      "review_only",
      "sort",
    ]);
    expect([...extras].sort()).toEqual([...NON_QUARANTINING_PREVIEW_STATUSES].sort());
  });

  it("matches the generated vocabulary exactly, in both directions", () => {
    expect([...PREVIEW_STATUSES].sort()).toEqual([...contract.preview_statuses].sort());
    expect([...NON_QUARANTINING_PREVIEW_STATUSES].sort()).toEqual(
      [...contract.non_quarantining_preview_statuses].sort(),
    );
  });

  it("lists every status once", () => {
    expect(new Set(PREVIEW_STATUSES).size).toBe(PREVIEW_STATUSES.length);
  });
});
