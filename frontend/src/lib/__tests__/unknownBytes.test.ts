/**
 * C-10 / I-10 on the frontend: an unknown byte count is not zero.
 *
 * `P1-FS-006(c)`. The task predicted `NaN` reaching a destructive preflight.
 * That does not happen — `formatBytes` returns its placeholder for `null`,
 * `undefined` and any non-finite number, so nothing renders as "NaN".
 *
 * The real defect in the same place is quieter. `requiredBytes` was typed
 * `number`, and `MainPage` supplied `impact?.required_bytes ?? 0`. Whenever
 * there was no frozen impact, "we do not know how much space this needs" became
 * "this needs zero bytes" — and the capacity check then compared free space
 * against `0`, found it sufficient, and reported an all-clear it had not
 * earned. A preflight that cannot measure something must say so, not pass it.
 */

import { describe, expect, it } from "vitest";

import { formatBytes } from "@/lib/formatters";
import { preflight, type PreflightInput } from "@/lib/operationCenter";

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    actionableGroups: 3,
    sourceMutations: 0,
    acknowledgedSourceMutations: false,
    staleGroups: 0,
    unresolvedGroups: 0,
    referenceCount: 0,
    freeBytes: 1_000,
    requiredBytes: 100,
    quarantineWritable: true,
    conversionWithoutOriginals: 0,
    companionsLeftInPlace: 0,
    ...overrides,
  } as PreflightInput;
}

describe("an unknown size renders as unknown", () => {
  it("never renders NaN", () => {
    expect(formatBytes(null)).not.toContain("NaN");
    expect(formatBytes(undefined)).not.toContain("NaN");
    expect(formatBytes(Number.NaN)).not.toContain("NaN");
  });

  it("uses the same placeholder for every kind of unknown", () => {
    const placeholder = formatBytes(null);

    expect(formatBytes(undefined)).toBe(placeholder);
    expect(formatBytes(Number.NaN)).toBe(placeholder);
    expect(placeholder.length).toBeGreaterThan(0);
  });

  it("still formats a known size", () => {
    // The guard against a placeholder that swallowed every number.
    expect(formatBytes(2048)).toMatch(/2/);
  });
});

describe("the capacity check cannot pass on an unknown requirement", () => {
  it("says so instead of reporting an all-clear", () => {
    const result = preflight(input({ requiredBytes: null, freeBytes: 1 }));

    expect(
      result.blocking.some((line) => line.messageKey === "preflight.blocking.spaceUnknown"),
    ).toBe(true);
    expect(result.canExecute).toBe(false);
  });

  it("does not report the unknown as a shortfall it measured", () => {
    // "Not enough space: 0 needed" would be a fabricated number.
    const result = preflight(input({ requiredBytes: null, freeBytes: 1 }));

    expect(result.blocking.some((line) => line.messageKey === "preflight.blocking.space")).toBe(
      false,
    );
  });

  it("still refuses a genuine shortfall", () => {
    const result = preflight(input({ requiredBytes: 10_000, freeBytes: 10 }));

    expect(result.blocking.some((line) => line.messageKey === "preflight.blocking.space")).toBe(
      true,
    );
  });

  it("still clears a run that genuinely fits", () => {
    // The guard against blocking everything, which would also satisfy the above.
    const result = preflight(input({ requiredBytes: 10, freeBytes: 10_000 }));

    expect(result.blocking).toEqual([]);
    expect(result.canExecute).toBe(true);
  });
});
