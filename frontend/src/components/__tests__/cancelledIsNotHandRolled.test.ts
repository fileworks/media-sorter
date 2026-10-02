/**
 * P-09, acceptance (2), as a check rather than a promise.
 *
 * The plan asked for "no remaining hand-rolled cancelled state". Read literally
 * that is not checkable: `cancelled` legitimately appears as a run status, a
 * phase label and a table chip, none of which are `StateView` panels. What must
 * not happen is a component deciding on its own *how a cancelled state looks* —
 * that is what produced a stage painted as `blocked` with the words swapped.
 *
 * So the assertion is: no component renders a `StateView` whose variant is
 * chosen by a cancellation flag but is not `cancelled`, and no component
 * restates the tone an operation outcome deserves. `presentOutcome` owns that.
 *
 * Sources are read through Vite's `?raw`, the same way `reviewFolders.test.ts`
 * reads the backend's folder maps.
 */

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Everything except the tests themselves and the module that owns the tone. */
function componentSources(): [string, string][] {
  return Object.entries(SOURCES).filter(
    ([path]) => !path.includes("__tests__") && !path.endsWith("statusPresentation.ts"),
  );
}

describe("cancelled has one presentation", () => {
  it("finds the components it is meant to be reading", () => {
    // Without this, an empty file list would satisfy every assertion below.
    const files = componentSources();

    expect(files.length).toBeGreaterThan(50);
    expect(files.some(([path]) => path.endsWith("StateView.tsx"))).toBe(true);
  });

  it("never picks a non-cancelled variant from a cancellation flag", () => {
    const offenders: string[] = [];

    for (const [path, source] of componentSources()) {
      // `variant={cancelled ? "x" : "y"}` — the shape that hid a cancelled
      // state inside another variant.
      const pattern = /variant=\{\s*cancelled\s*\?\s*"([a-z-]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        if (match[1] !== "cancelled") {
          offenders.push(`${path}: cancelled renders as "${match[1]}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not restate the tone of an operation outcome", () => {
    // A per-component map keyed by outcome is a second opinion about the same
    // words. There were three of these; the banner in ReportPanel was not one
    // the plan named, and this assertion is what found it.
    const offenders: string[] = [];

    for (const [path, source] of componentSources()) {
      if (/\bcancelled:\s*"[^"]*\b(bg|text|border)-/.test(source)) {
        offenders.push(`${path}: hardcodes colours for a cancelled outcome`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
