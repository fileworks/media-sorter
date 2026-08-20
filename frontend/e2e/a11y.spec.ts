import { expect, test } from "@playwright/test";
import {
  MIN_TARGET_PX,
  contrastViolations,
  focusObscuredBy,
  stubBackend,
  tabStops,
  undersizedTargets,
} from "./support";

/**
 * `P2-TEST-001` — the three WCAG criteria jsdom cannot decide.
 *
 * Each criterion is checked against the real app *and* against a page
 * deliberately broken in the way the criterion exists to catch. The negative
 * controls are the point: an a11y check that has never been seen to fail is
 * indistinguishable from one that cannot fail, and this suite is being added
 * precisely because the jsdom suite's silence on these three was structural
 * rather than earned.
 */

test.beforeEach(async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");
  // The shell mounts behind a lazy boundary; wait for real content, not a spinner.
  await page.waitForSelector("main, [role='main'], button", { timeout: 30_000 });
  await expect(
    page.getByText(/something went wrong|unexpected error/i),
    "the app must render, not its ErrorBoundary — otherwise this suite audits an error screen",
  ).toHaveCount(0);
});

/**
 * The guard that keeps every "no violations" result meaningful.
 *
 * This suite already produced one false pass: a config stub missing
 * `library.roots` crashed the app into its ErrorBoundary, and seven green
 * checks were auditing an error screen. An assertion that the page is
 * substantially populated is what makes the silence of the others earned.
 */
test("the page under test is actually populated", async ({ page }) => {
  const counts = await page.evaluate(() => ({
    buttons: document.querySelectorAll("button").length,
    landmarks: document.querySelectorAll("main, nav, [role='main'], [role='navigation']").length,
  }));
  expect(counts.buttons).toBeGreaterThanOrEqual(8);
  expect(counts.landmarks).toBeGreaterThanOrEqual(1);

  let stops = 0;
  for await (const stop of tabStops(page)) {
    void stop;
    stops += 1;
  }
  expect(
    stops,
    "too few keyboard stops for the focus checks to mean anything",
  ).toBeGreaterThanOrEqual(5);
});

test.describe("1.4.3 contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`text meets contrast in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
      }, theme);
      await page.waitForTimeout(150); // let the theme transition settle

      const violations = await contrastViolations(page);

      expect(
        violations,
        violations
          .flatMap((violation) =>
            violation.nodes.map((node) => `${node.target.join(" ")} — ${node.failureSummary}`),
          )
          .join("\n"),
      ).toEqual([]);
    });
  }

  test("the check fails on text that genuinely lacks contrast", async ({ page }) => {
    await page.evaluate(() => {
      const probe = document.createElement("p");
      probe.id = "contrast-probe";
      probe.textContent = "deliberately unreadable";
      // An opaque background is required: axe declines to judge contrast it
      // cannot compute, so a probe that let the page show through would report
      // "incomplete" rather than "violation" and this control would flake.
      probe.style.cssText =
        "color:#bbbbbb;background-color:#c4c4c4;font-size:14px;padding:8px;" +
        "position:fixed;top:0;left:0;z-index:9999;opacity:1";
      document.body.appendChild(probe);
    });
    await page.locator("#contrast-probe").waitFor({ state: "visible" });

    const violations = await contrastViolations(page);

    expect(violations.some((v) => v.id === "color-contrast")).toBe(true);
  });
});

test.describe("2.4.11 focus not obscured", () => {
  test("no keyboard stop is covered by another element", async ({ page }) => {
    const obscured: string[] = [];
    for await (const stop of tabStops(page)) {
      void stop;
      const hit = await focusObscuredBy(page);
      if (hit) obscured.push(`${hit.label} covered by ${hit.coveredBy}`);
    }

    expect(obscured, obscured.join("\n")).toEqual([]);
  });

  test("the check fails when a focused control is deliberately covered", async ({ page }) => {
    // This is the acceptance criterion for the task, stated as a test: a
    // deliberately obscured focus target must make the suite fail.
    await page.keyboard.press("Tab");
    const before = await focusObscuredBy(page);
    expect(before, "the first tab stop should start unobscured").toBeNull();

    await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      const box = active.getBoundingClientRect();
      const veil = document.createElement("div");
      veil.id = "focus-veil";
      veil.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;background:#000;z-index:99999`;
      document.body.appendChild(veil);
    });
    await page.locator("#focus-veil").waitFor({ state: "visible" });

    const after = await focusObscuredBy(page);

    expect(after).not.toBeNull();
    expect(after?.coveredBy).toContain("focus-veil");
  });
});

test.describe("later stages", () => {
  /**
   * `P2-TEST-001b` finding, recorded rather than papered over.
   *
   * Recipe, Configure, Plan, Review and Execute are gated on `rootsReady`,
   * which is derived from validated root *state* rather than from configured
   * roots — so stubbing config and `/api/config/validate` is not enough to
   * enter them, and there is no route to deep-link to a stage because the flow
   * holds its position in React state rather than in the URL.
   *
   * Reaching them from a browser test needs one of: a live backend with real
   * folders, a fuller stub of the root-state endpoints, or a test-only entry
   * point. Each is a decision about the app rather than about this suite, so
   * this test states the gap and skips instead of asserting nothing quietly.
   * The screens are not unaudited meanwhile — the jsdom suite renders every one
   * of them; what is missing there is only contrast, 2.4.11 and 2.5.8.
   */
  test("configure and review are reachable for a browser-level audit", async ({ page }) => {
    const configure = page.getByRole("button", { name: /configure/i }).first();
    const reachable = (await configure.count()) > 0 && !(await configure.isDisabled());
    test.skip(
      !reachable,
      "stages past Sources need validated root state; see P2-TEST-001b in the residual-risk register",
    );

    await configure.click();
    await page.waitForTimeout(500);
    const violations = await contrastViolations(page);
    const undersized = await undersizedTargets(page);

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    expect(
      undersized,
      undersized.map((t) => `${t.label} — ${t.width}x${t.height}`).join("\n"),
    ).toEqual([]);
  });
});

test.describe("2.5.8 target size", () => {
  test("every pointer target is at least 24x24", async ({ page }) => {
    const undersized = await undersizedTargets(page);

    expect(
      undersized,
      undersized.map((t) => `${t.label} — ${t.width}x${t.height}`).join("\n"),
    ).toEqual([]);
  });

  test("the check fails on a target smaller than the minimum", async ({ page }) => {
    await page.evaluate((minimum) => {
      const probe = document.createElement("button");
      probe.id = "tiny-probe";
      probe.textContent = "x";
      probe.style.cssText = `width:${minimum - 8}px;height:${minimum - 8}px;padding:0;position:fixed;bottom:0;right:0`;
      document.body.appendChild(probe);
    }, MIN_TARGET_PX);
    await page.locator("#tiny-probe").waitFor({ state: "visible" });

    const undersized = await undersizedTargets(page);

    expect(undersized.some((t) => t.label === "x")).toBe(true);
  });
});
