import { describe, expect, it } from "vitest";

import { editableAiTags } from "@/lib/reviewTags";

describe("editableAiTags", () => {
  const edits = new Map([["/in/a.jpg", ["edited"]]]);

  it("offers the proposal, or Review's edit of it, for a file the run places", () => {
    expect(
      editableAiTags({ source: "/in/b.jpg", status: "organize", aiTags: ["beach"] }, edits),
    ).toEqual(["beach"]);
    expect(
      editableAiTags({ source: "/in/a.jpg", status: "organize", aiTags: ["beach"] }, edits),
    ).toEqual(["edited"]);
  });

  it("hides the editor for a copy the run sets aside untagged", () => {
    expect(
      editableAiTags({ source: "/in/a.jpg", status: "duplicate", aiTags: ["beach"] }, edits),
    ).toBeNull();
  });

  it("hides the editor when tagging was off for the file", () => {
    expect(
      editableAiTags({ source: "/in/a.jpg", status: "organize", aiTags: null }, edits),
    ).toBeNull();
  });
});
