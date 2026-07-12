import { describe, it, expect } from "vitest";
import { getBasename, sanitizeCategory } from "@/lib/pathUtils";

describe("getBasename", () => {
  it("extracts the final segment from POSIX paths", () => {
    expect(getBasename("/home/me/photo.jpg")).toBe("photo.jpg");
    expect(getBasename("photo.jpg")).toBe("photo.jpg");
  });

  it("extracts the final segment from Windows paths", () => {
    expect(getBasename("C:\\Users\\me\\photo.jpg")).toBe("photo.jpg");
  });

  it("handles mixed separators", () => {
    expect(getBasename("a/b\\c\\photo.png")).toBe("photo.png");
  });

  it("handles edge cases (empty string, trailing slash)", () => {
    expect(getBasename("")).toBe("");
    expect(getBasename("/a/b/")).toBe("");
  });
});

describe("sanitizeCategory", () => {
  it("keeps a plain name and trims surrounding whitespace", () => {
    expect(sanitizeCategory("food")).toBe("food");
    expect(sanitizeCategory("  food  ")).toBe("food");
  });

  it("keeps internal spaces (collapsed) and hyphens", () => {
    expect(sanitizeCategory("my  receipts")).toBe("my receipts");
    expect(sanitizeCategory("iPhone-15")).toBe("iPhone-15");
  });

  it("strips path separators and illegal characters", () => {
    expect(sanitizeCategory("a/b")).toBe("ab");
    expect(sanitizeCategory("a\\b")).toBe("ab");
    expect(sanitizeCategory('a<b>c"d|e?f*g')).toBe("abcdefg");
  });

  it("neutralises parent-traversal sequences", () => {
    expect(sanitizeCategory("..")).toBe("");
    expect(sanitizeCategory("../etc")).toBe("etc");
  });

  it("strips leading/trailing dots and spaces", () => {
    expect(sanitizeCategory("...hidden")).toBe("hidden");
    expect(sanitizeCategory("trailing.")).toBe("trailing");
  });

  it("caps the length", () => {
    expect(sanitizeCategory("x".repeat(200)).length).toBe(64);
  });

  it("keeps unicode letters", () => {
    expect(sanitizeCategory("Münchën")).toBe("Münchën");
  });

  it("is idempotent", () => {
    const once = sanitizeCategory("../My Photos: 2024?");
    expect(sanitizeCategory(once)).toBe(once);
  });
});
