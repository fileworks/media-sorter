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
  const resolveTab = page.getByRole("tab", { name: /decide the duplicates/i });
  await expect(resolveTab).toHaveAttribute("aria-selected", "true");

  const quickDecision = page.getByRole("button", { name: /auto-keep the recommended file/i });
  await expect(quickDecision).toBeVisible();
  expect((await quickDecision.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await quickDecision.tap();
  await expect(page.getByText(/every set has been decided/i)).toBeVisible();

  await page.getByRole("tab", { name: /browse the result/i }).tap();
  await page.getByRole("button", { name: /grid view/i }).tap();
  const selection = page.getByRole("checkbox", { name: /select corrupt\.jpg/i });
  await expect(selection).toBeVisible();
  await expect(selection.locator("xpath=..")).toHaveCSS("opacity", "1");
  await selection.tap();
  await expect(selection).toBeChecked();
});
