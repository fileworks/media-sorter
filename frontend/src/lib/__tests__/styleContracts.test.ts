// @ts-expect-error Vitest supplies the Node runtime used by this test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("responsive and motion style contracts", () => {
  it("hides named candidate data columns without hiding state badges", () => {
    expect(styles).toContain(".candidate-destination");
    expect(styles).toContain(".candidate-date-source");
    expect(styles).not.toContain(".candidate-grid > *:nth-child");
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
