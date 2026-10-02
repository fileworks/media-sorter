import { describe, expect, it } from "vitest";

import { extractErrorMessage, userFacingError } from "@/lib/errorUtils";

describe("error presentation boundary", () => {
  it("uses a structured backend error without exposing following detail", () => {
    const error = {
      response: { data: { error: "The selected plan is stale.\nprivate diagnostic" } },
    };

    expect(extractErrorMessage(error, "Fallback").message).toBe("The selected plan is stale.");
  });

  it("accepts FastAPI detail envelopes", () => {
    const error = {
      response: { data: { detail: "Review and acknowledge the impact first" } },
    };

    expect(extractErrorMessage(error, "Fallback").message).toBe(
      "Review and acknowledge the impact first",
    );
  });

  it("maps unstructured native errors to the caller's interface message", () => {
    expect(
      extractErrorMessage(new Error("socket internals exploded"), "Could not connect.").message,
    ).toBe("Could not connect.");
  });

  it("returns the envelope's code beside the message", () => {
    const error = {
      response: { data: { error: "That group is gone.", code: "PLAN_STALE", details: { id: 7 } } },
    };

    expect(extractErrorMessage(error, "Fallback")).toEqual({
      message: "That group is gone.",
      code: "PLAN_STALE",
      details: { id: 7 },
    });
  });

  it("omits the code when the envelope carries none", () => {
    const error = { response: { data: { error: "Plain failure." } } };

    expect(extractErrorMessage(error, "Fallback").code).toBeUndefined();
  });

  it("keeps a code that arrives without a message, falling back for the sentence", () => {
    const error = { response: { data: { code: "INTERNAL_ERROR" } } };

    expect(extractErrorMessage(error, "Could not connect.")).toMatchObject({
      message: "Could not connect.",
      code: "INTERNAL_ERROR",
    });
  });

  it("reports no code for a native error", () => {
    expect(extractErrorMessage(new Error("boom"), "Fallback").code).toBeUndefined();
  });

  it("replaces stack traces and implementation exception names", () => {
    expect(userFacingError('Traceback\n  File "worker.py", line 3')).not.toContain("worker.py");
    expect(userFacingError("TypeError: cannot read private field")).toBe(
      "The operation could not be completed. Try again or check the operation log.",
    );
  });

  it("bounds otherwise safe structured messages", () => {
    expect(userFacingError("x".repeat(500))).toHaveLength(320);
  });
});
