// @ts-expect-error Vitest supplies the Node runtime used by this test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("responsive and motion style contracts", () => {
  it("keeps one review grid, dropping its columns from the right", () => {
    // The header row shares this class with its rows, which is what stops a
    // heading from naming a column the rows do not have. Columns go from the
    // right, least-decisive first: destination at 1280, status at 900.
    expect(styles).toContain(".asset-grid");
    expect(styles).toMatch(/\.asset-grid > \*:nth-child\(6\)/);
    expect(styles).toMatch(/\.asset-grid > \*:nth-child\(5\)/);
    // Resolve had a second grid of its own. A duplicate set is a list of
    // copies, not a table of facts, and its rows now lay themselves out.
    expect(styles).not.toContain("candidate-grid");
    expect(styles).not.toContain("candidate-destination");
  });

  it("marks a read-only region without dimming the text inside it", () => {
    // Opacity on a region drags AA-tuned copy below AA exactly where somebody
    // is being asked to read why they cannot edit it.
    const region = styles.match(/\.read-only-region\s*{[^}]*}/s)?.[0];
    expect(region).toBeDefined();
    expect(region).toContain("saturate");
    expect(region).not.toContain("opacity");
  });

  it("keeps indeterminate progress visible when animation is reduced", () => {
    expect(styles).toMatch(
      /\.progress-indeterminate::after\s*{[^}]*left:\s*0;[^}]*width:\s*100%;/s,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*{\s*\.progress-indeterminate::after\s*{[^}]*animation:/s,
    );
  });
});
