import { describe, expect, it } from "vitest";

import { sanitizeForShellLog } from "@/lib/shellLog";

describe("sanitizeForShellLog", () => {
  it("removes credentials and user paths but keeps the message", () => {
    const cleaned = sanitizeForShellLog(
      "TypeError: failed for C:\\Users\\Anna\\Pictures\\a.jpg with capability=abc123 and /Users/anna/Pictures/b.jpg",
    );

    expect(cleaned).toContain("TypeError: failed for <path>");
    expect(cleaned).toContain("capability=[REDACTED]");
    expect(cleaned).not.toContain("Anna");
    expect(cleaned).not.toContain("anna");
    expect(cleaned).not.toContain("abc123");
  });

  it("bounds the length and flattens new lines", () => {
    const cleaned = sanitizeForShellLog(`first\nsecond ${"x".repeat(5000)}`);

    expect(cleaned.startsWith("first second")).toBe(true);
    expect(cleaned.length).toBe(1500);
  });
});
