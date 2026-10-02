import { describe, expect, it } from "vitest";

import { invalidationForConfigPatch } from "@/lib/workflowInvalidation";

describe("workflow artifact invalidation", () => {
  it("invalidates the scan when source scope or traversal changes", () => {
    expect(invalidationForConfigPatch({ source_directory: "/new/source" })).toBe("scan");
    expect(invalidationForConfigPatch({ recursive_scan: false })).toBe("scan");
    expect(invalidationForConfigPatch({ companion_handling: "leave_in_place" })).toBe("scan");
  });

  it("preserves the scan but invalidates preview and decisions for matching changes", () => {
    expect(invalidationForConfigPatch({ duplicate_perceptual_threshold: 7 })).toBe("preview");
    expect(invalidationForConfigPatch({ rename_pattern: "YYYY-MM-DD" })).toBe("preview");
  });

  it("does not invalidate run artifacts for presentation and cache preferences", () => {
    expect(invalidationForConfigPatch({ thumbnail_cache_enabled: false })).toBe("none");
    expect(invalidationForConfigPatch({ update_check_enabled: false })).toBe("none");
  });

  it("invalidates preview when locale changes bundled labels and category names", () => {
    expect(invalidationForConfigPatch({ language: "de" })).toBe("preview");
  });

  it("chooses the oldest affected artifact for a mixed patch", () => {
    expect(
      invalidationForConfigPatch({ language: "de", recursive_scan: false, rename: true }),
    ).toBe("scan");
  });
});
