import { describe, expect, it } from "vitest";

// The backend's own map, read rather than restated: a second copy of this list
// is precisely the bug this test exists to prevent.
import destinationSource from "../../../../backend/app/services/destination.py?raw";
import { REVIEW_FOLDER_NAMES } from "@/lib/reviewPlan";

/**
 * The interface marks a folder as "somewhere to look" purely by name. When that
 * list drifts from the names the sort actually writes, files land in folders
 * the interface renders as ordinary date folders — which is what had happened
 * to `_unknown_dates`, `_future_dates` and `_corrupted`.
 */
describe("review folder names", () => {
  function backendQuarantineFolders(): string[] {
    const block = destinationSource.match(/QUARANTINE_FOLDERS: dict\[str, str\] = \{([\s\S]*?)\}/);
    if (!block) throw new Error("QUARANTINE_FOLDERS not found — did the backend move it?");
    return [...block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((match) => match[2]);
  }

  it("matches the folders the sort actually writes", () => {
    expect([...REVIEW_FOLDER_NAMES].sort()).toEqual(backendQuarantineFolders().sort());
  });

  it("uses the plural forms the backend writes", () => {
    expect(REVIEW_FOLDER_NAMES).toContain("_unknown_dates");
    expect(REVIEW_FOLDER_NAMES).toContain("_future_dates");
    expect(REVIEW_FOLDER_NAMES).not.toContain("_unknown_date");
    expect(REVIEW_FOLDER_NAMES).not.toContain("_future_date");
  });

  it("includes the corrupted folder that was missing", () => {
    expect(REVIEW_FOLDER_NAMES).toContain("_corrupted");
  });
});
