import { expect, test } from "@playwright/test";

import { E2E_ANALYSIS, E2E_PREVIEW_RESULT, stubBackend } from "./support";

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
  await page.goto("/");
  await expect(page.locator('[data-stage-id="review"]')).toHaveAttribute("aria-current", "step");
});

test("the touch workflow exposes the quick decision and persistent selection controls", async ({
  page,
}) => {
  // Review opens on Browse; reaching the decision queue is a deliberate act.
  const resolveTab = page.getByRole("tab", { name: /decide the duplicates/i });
  await resolveTab.tap();
  await expect(resolveTab).toHaveAttribute("aria-selected", "true");

  const quickDecision = page.getByRole("button", { name: /^apply to 1 open set/i });
  await expect(quickDecision).toBeVisible();
  expect((await quickDecision.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await quickDecision.tap();

  // A decision covering more than one set states its impact before it acts.
  const impact = page.getByRole("dialog", { name: /accept the recommended copies/i });
  await expect(impact).toBeVisible();
  // The panel enters with a `scale(0.992)`; measuring mid-animation reported a
  // 44px target as 43.9 and failed a control that is the right size.
  await impact.evaluate(async (panel) => {
    await Promise.all(
      panel.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
    );
  });
  const accept = impact.getByRole("button", { name: /^accept the recommendations$/i });
  expect((await accept.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await accept.tap();
  await expect(page.getByText(/every set has been decided/i)).toBeVisible();

  await page.getByRole("tab", { name: /browse the result/i }).tap();
  await page.getByRole("button", { name: /grid view/i }).tap();
  const selection = page.getByRole("checkbox", { name: /select corrupt\.jpg/i });
  await expect(selection).toBeVisible();
  await expect(selection.locator("xpath=..")).toHaveCSS("opacity", "1");
  await selection.tap();
  await expect(selection).toBeChecked();
});
