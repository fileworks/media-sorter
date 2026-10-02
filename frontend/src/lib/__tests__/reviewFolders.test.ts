import { describe, expect, it } from "vitest";

// The backend's own maps, read rather than restated: a second copy of this list
// is precisely the bug this test exists to prevent.
//
// Two modules since `P1-ARCH-001`. `QUARANTINE_FOLDERS` and
// `CONTEXTUAL_COPY_FOLDER` moved to `core/destination_paths.py` so that
// `core/sort_plan.py` could stop importing `app.services`; the retired-name set
// stays in the service that recognises old layouts on disk. Both are read, so
// this still fails if either drifts — and it failed loudly when they moved,
// which is the test working rather than the test being brittle.
import corePathsSource from "../../../../backend/app/core/destination_paths.py?raw";
import destinationSource from "../../../../backend/app/services/destination.py?raw";
import { REVIEW_FOLDER_NAMES } from "@/lib/reviewPlan";

/**
 * The interface marks a folder as "somewhere to look" purely by name. When that
 * list drifts from the names the sort actually writes, files land in folders
 * the interface renders as ordinary date folders — which is what had happened
 * to `_unknown_dates`, `_future_dates` and `_corrupted`.
 */
describe("review folder names", () => {
  function backendReviewFolders(): string[] {
    const block = corePathsSource.match(/QUARANTINE_FOLDERS: dict\[str, str\] = \{([\s\S]*?)\}/);
    if (!block) throw new Error("QUARANTINE_FOLDERS not found — did the backend move it?");
    const current = [...block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((match) => match[2]);
    const retiredBlock = destinationSource.match(
      /RETIRED_QUARANTINE_FOLDERS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/,
    );
    if (!retiredBlock) throw new Error("RETIRED_QUARANTINE_FOLDERS not found");
    const retired = [...retiredBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const copies = corePathsSource.match(/CONTEXTUAL_COPY_FOLDER = "([^"]+)"/)?.[1];
    if (!copies) throw new Error("CONTEXTUAL_COPY_FOLDER not found");
    return [...new Set([...current, ...retired, copies])];
  }

  it("matches the current and retired folders the backend recognises", () => {
    expect([...REVIEW_FOLDER_NAMES].sort()).toEqual(backendReviewFolders().sort());
  });

  it("recognises the merged current names and the retired layout", () => {
    expect(REVIEW_FOLDER_NAMES).toContain("_undated");
    expect(REVIEW_FOLDER_NAMES).toContain("_copies");
    expect(REVIEW_FOLDER_NAMES).toContain("_unknown_dates");
    expect(REVIEW_FOLDER_NAMES).toContain("_future_dates");
    expect(REVIEW_FOLDER_NAMES).toContain("_corrupted");
    expect(REVIEW_FOLDER_NAMES).toContain("_failed");
  });
});
