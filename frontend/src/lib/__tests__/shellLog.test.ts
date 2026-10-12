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

  it.each([
    ["Authorization: Bearer SYNTHETIC-SECRET", "Authorization=[REDACTED]"],
    ["sent Bearer SYNTHETIC-SECRET upstream", "Bearer [REDACTED]"],
    ['failed request {"token":"SYNTHETIC-SECRET"}', "token=[REDACTED]"],
    ["failed request {'api_key': 'SYNTHETIC-SECRET'}", "api_key=[REDACTED]"],
    ["password = SYNTHETIC-SECRET", "password=[REDACTED]"],
  ])("redacts the credential in %s", (message, kept) => {
    const cleaned = sanitizeForShellLog(message);

    expect(cleaned).toContain(kept);
    expect(cleaned).not.toContain("SYNTHETIC-SECRET");
  });

  it.each([
    "failed C:/Users/Example/Pictures/personal.jpg",
    "failed \\\\nas\\Example\\Pictures\\personal.jpg",
    "failed //nas/Example/Pictures/personal.jpg",
    "failed file:///home/example/personal.jpg",
    'failed "/media/example/personal.jpg"',
  ])("removes the user path in %s", (message) => {
    const cleaned = sanitizeForShellLog(message);

    expect(cleaned).toContain("failed");
    expect(cleaned).toContain("<path>");
    expect(cleaned).not.toMatch(/example|personal/i);
  });

  it("keeps request URLs readable", () => {
    expect(sanitizeForShellLog("GET http://127.0.0.1:8765/api/health failed")).toBe(
      "GET http://127.0.0.1:8765/api/health failed",
    );
  });

  it("bounds the length and flattens new lines", () => {
    const cleaned = sanitizeForShellLog(`first\nsecond ${"x".repeat(5000)}`);

    expect(cleaned.startsWith("first second")).toBe(true);
    expect(cleaned.length).toBe(1500);
  });
});
