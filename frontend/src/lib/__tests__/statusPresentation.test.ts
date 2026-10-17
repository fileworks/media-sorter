import { describe, expect, it } from "vitest";

import { presentOutcome, severityClass } from "@/lib/statusPresentation";

describe("presentOutcome", () => {
  it("gives every outcome one tone", () => {
    expect(presentOutcome("completed").tone).toBe("success");
    expect(presentOutcome("completed_with_warnings").tone).toBe("warning");
    expect(presentOutcome("partial").tone).toBe("warning");
    expect(presentOutcome("cancelled").tone).toBe("info");
    expect(presentOutcome("failed").tone).toBe("error");
  });
});

describe("severity tokens", () => {
  it("gives states and notification banners one semantic token vocabulary", () => {
    expect(severityClass("info")).toContain("border-info");
    expect(severityClass("warning")).toContain("border-warning");
    expect(severityClass("error")).toContain("border-error");
    expect(severityClass("neutral")).toContain("border-border");
  });
});
