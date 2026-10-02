import { expect, test } from "@playwright/test";

import { E2E_ANALYSIS, E2E_PREVIEW_RESULT, stubBackend, openSurface } from "./support";

/**
 * A locked stage can be read — which means its text can be selected and copied.
 *
 * jsdom cannot decide this. Text selection is a layout-and-hit-testing
 * behaviour: there are no ranges to drag over elements that are all 0×0, and
 * `inert`'s effect on selection is implemented by the engine, not by the DOM
 * API. The lock used to be an `inert` region with `user-select: none`, which
 * blocked every control *and* every selection — so a reader sent to a locked
 * screen to check a destination path could not copy the path. The boundary is a
 * native `fieldset[disabled]` now, and these two tests are what keep it one.
 */

test.beforeEach(async ({ page }) => {
  await stubBackend(page);
  await page.addInitScript(
    ({ result, analysis }) => {
      localStorage.setItem(
        "mediasort_completed_plan",
        JSON.stringify({
          schemaVersion: 3,
          planId: result.plan_id,
          configFingerprint: result.config_fingerprint,
          analysis,
        }),
      );
    },
    { result: E2E_PREVIEW_RESULT, analysis: E2E_ANALYSIS },
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.waitForSelector("main, button");
  // A calculated plan is what locks the stages that fed it.
  await openSurface(page, "configure");
  await openSurface(page, "plan");
  await openSurface(page, "configure");
  await expect(page.getByRole("button", { name: /edit settings/i })).toBeVisible();
});

test("text inside the locked region can still be selected", async ({ page }) => {
  // A setting's own explanation, inside the locked region — the kind of line a
  // reader highlights to quote or to search for.
  const sentence = page.getByText("What this run is for.", { exact: true });
  await expect(sentence).toBeVisible();

  const selected = await sentence.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? "";
  });

  expect(selected).toContain("What this run is for.");
});

test("every control inside it is disabled, and the way out is not", async ({ page }) => {
  const boundary = page.locator("fieldset[disabled].read-only-region");
  await expect(boundary).toHaveCount(1);

  // Not a sample: every native control below the boundary, or the next control
  // added to Configure is the one that stays live inside a locked screen.
  const live = await boundary.evaluate(
    (region) =>
      [...region.querySelectorAll("input, select, textarea, button")].filter(
        (control) => !control.matches(":disabled"),
      ).length,
  );
  expect(live).toBe(0);

  const unlock = page.getByRole("button", { name: /edit settings/i });
  await expect(unlock).toBeEnabled();
  expect(await unlock.evaluate((element) => element.closest("fieldset[disabled]"))).toBeNull();
});
