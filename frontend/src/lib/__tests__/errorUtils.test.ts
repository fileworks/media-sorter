import { describe, expect, it } from "vitest";

import { extractErrorMessage, userFacingError } from "@/lib/errorUtils";

describe("error presentation boundary", () => {
  it("uses a structured backend error without exposing following detail", () => {
    const error = {
      response: { data: { error: "The selected plan is stale.\nprivate diagnostic" } },
    };

    expect(extractErrorMessage(error, "Fallback")).toBe("The selected plan is stale.");
  });

  it("accepts FastAPI detail envelopes", () => {
    const error = {
      response: { data: { detail: "Review and acknowledge the impact first" } },
    };

    expect(extractErrorMessage(error, "Fallback")).toBe("Review and acknowledge the impact first");
  });

  it("maps unstructured native errors to the caller's interface message", () => {
    expect(extractErrorMessage(new Error("socket internals exploded"), "Could not connect.")).toBe(
      "Could not connect.",
    );
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
