import { describe, expect, it } from "vitest";

import { sanitizeForShellLog, WITHHELD } from "@/lib/shellLog";

describe("sanitizeForShellLog", () => {
  it("keeps the message up to the first path and withholds the rest", () => {
    const cleaned = sanitizeForShellLog(
      "TypeError: failed for C:\\Users\\Anna\\Pictures\\a.jpg with capability=abc123 and /Users/anna/Pictures/b.jpg",
    );

    expect(cleaned).toBe(`TypeError: failed for ${WITHHELD}`);
  });

  // Every private value must be gone, whatever its spelling. The end of a path
  // with spaces or of an escaped secret cannot be found reliably, so nothing
  // after the first marker survives (F1-004).
  it.each([
    "Authorization: Bearer SYNTHETIC-SECRET",
    "sent Bearer SYNTHETIC-SECRET upstream",
    'failed request {"token":"SYNTHETIC-SECRET"}',
    "failed request {'api_key': 'SYNTHETIC-SECRET'}",
    "password = SYNTHETIC-SECRET",
    'failed request {"password":"SYNTHETIC\\"SECRET"}',
    "Cookie: session=SYNTHETIC-SECRET; refresh=SYNTHETIC-SECRET",
    "set-cookie: id=SYNTHETIC-SECRET",
    "GET /api/files?token=SYNTHETIC-SECRET failed",
    // F3-001: credential names with a prefix.
    "access_token=SYNTHETIC-SECRET",
    "refresh_token=SYNTHETIC-SECRET",
    "client_secret=SYNTHETIC-SECRET",
    "x-api-key: SYNTHETIC-SECRET",
    // F1-004 re-check: quotes escaped by an earlier serialization.
    '{"message":"failed {\\"token\\":\\"SYNTHETIC-SECRET\\"}"}',
  ])("withholds the credential in %s", (message) => {
    const cleaned = sanitizeForShellLog(message);

    expect(cleaned).toContain(WITHHELD);
    expect(cleaned).not.toContain("SECRET");
  });

  it.each([
    "failed C:/Users/Example/Pictures/personal.jpg",
    'failed to open "C:/Users/Example/My Pictures/personal.jpg"',
    "failed C:\\Users\\Example\\My Pictures\\personal.jpg",
    'failed to open "\\\\nas\\Example\\My Pictures\\personal.jpg"',
    "failed //nas/Example/Pictures/personal.jpg",
    "failed file:///home/example/My Pictures/personal.jpg",
    'failed "/media/example/My Pictures/personal.jpg"',
    "failed /Users/example/My Pictures/personal.jpg",
    "failed ~/My Pictures/personal.jpg",
  ])("withholds the user path in %s", (message) => {
    const cleaned = sanitizeForShellLog(message);

    expect(cleaned.startsWith("failed")).toBe(true);
    expect(cleaned).toContain(WITHHELD);
    expect(cleaned).not.toMatch(/example|personal|pictures/i);
  });

  it.each([
    "GET http://127.0.0.1:8765/api/health failed",
    "SyntaxError: Unexpected token < in JSON at position 0",
    "TypeError: Cannot read properties of undefined (reading 'session')",
  ])("keeps a message without private markers intact: %s", (message) => {
    expect(sanitizeForShellLog(message)).toBe(message);
  });

  it("bounds the length and flattens new lines", () => {
    const cleaned = sanitizeForShellLog(`first\nsecond ${"x".repeat(5000)}`);

    expect(cleaned.startsWith("first second")).toBe(true);
    expect(cleaned.length).toBe(1500);
  });
});
