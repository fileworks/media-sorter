import { describe, it, expect } from "vitest";
import {
  RENAME_TOKENS,
  renderPattern,
  renderPatternParts,
  validateRenamePattern,
} from "@/lib/renamePattern";

const DATE = new Date(2024, 2, 15, 10, 30, 0); // 2024-03-15

describe("validateRenamePattern", () => {
  it("flags an empty pattern as an error", () => {
    expect(validateRenamePattern("").error).toBeTruthy();
  });

  it("rejects slashes (would create subfolders)", () => {
    expect(validateRenamePattern("YYYY/MM").error).toMatch(/slash/i);
    expect(validateRenamePattern("a\\b").error).toMatch(/slash/i);
  });

  it("warns when there are no variables (all files would collide)", () => {
    expect(validateRenamePattern("holiday").warning).toBeTruthy();
  });

  it("accepts a pattern containing at least one variable", () => {
    expect(validateRenamePattern("TYPE_YYYY-MM-DD")).toEqual({});
    expect(validateRenamePattern("IMG_YYYY")).toEqual({}); // literal prefix + token
  });
});

describe("renderPatternParts", () => {
  it("splits into token-derived and literal segments", () => {
    const parts = renderPatternParts("YYYY-MM-DD", DATE, "IMG_001", ".jpg", "IMG");
    expect(parts).toEqual([
      { text: "2024", isToken: true },
      { text: "-", isToken: false },
      { text: "03", isToken: true },
      { text: "-", isToken: false },
      { text: "15", isToken: true },
      { text: ".jpg", isToken: false },
    ]);
  });

  it("expands NAME and TYPE and keeps literals verbatim", () => {
    expect(renderPattern("TYPE_NAME", DATE, "IMG_001", ".jpg", "IMG")).toBe("IMG_IMG_001.jpg");
    expect(renderPattern("TYPE_NAME", DATE, "VID_0042", ".mp4", "VID")).toBe("VID_VID_0042.mp4");
  });

  it("does not let a literal that contains a token-like word get clobbered twice", () => {
    // A NAME of "TYPEthing" must survive: NAME expands once, the substituted
    // text is not re-scanned for tokens.
    expect(renderPattern("NAME", DATE, "TYPEthing", ".jpg", "IMG")).toBe("TYPEthing.jpg");
  });

  it("treats unknown uppercase runs as literals", () => {
    expect(renderPattern("FOO_YYYY", DATE, "x", ".jpg", "IMG")).toBe("FOO_2024.jpg");
  });
});

describe("RENAME_TOKENS", () => {
  it("exposes the five supported variables", () => {
    expect(RENAME_TOKENS.map((t) => t.token)).toEqual(["YYYY", "MM", "DD", "NAME", "TYPE"]);
  });
});
