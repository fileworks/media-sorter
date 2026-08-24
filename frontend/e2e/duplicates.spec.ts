import { expect, test, type Page } from "@playwright/test";

import { E2E_ANALYSIS, E2E_RECOVERY, duplicatePlan, stubBackend } from "./support";

/**
 * The duplicate workflow, driven the way a person drives it.
 *
 * Every assertion here is one jsdom cannot make. Resolve pins its decision bar
 * to the bottom of the pane and floats a bulk bar over it; a control covered by
 * either still receives a synthetic click in jsdom and reports success. Real
 * clicks refuse, which is the point of running this in a browser.
 */

const { groups, result } = duplicatePlan(3);

async function openResolve(page: Page) {
  await page.locator('[data-stage-id="configure"]').click();
  await page.locator('[data-stage-id="plan"]').click();
  await page.locator('[data-stage-id="review"]').click();
  await page.getByRole("tab", { name: /decide the duplicates/i }).click();
  await expect(page.getByRole("button", { name: /^compare$/i })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await stubBackend(page);
  await page.route("**/api/review/groups**", async (route) => {
    const kind = new URL(route.request().url()).searchParams.get("kind") ?? "exact";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        groups: kind === "exact" ? groups : [],
        next_cursor: null,
        kind,
        truncated: false,
        partial_index: false,
      }),
    });
  });
  await page.addInitScript(
    ({ result, recovery, analysis }) => {
      localStorage.setItem(
        "mediasort_completed_plan",
        JSON.stringify({ schemaVersion: 2, planId: result.plan_id, result, recovery, analysis }),
      );
    },
    { result, recovery: E2E_RECOVERY, analysis: E2E_ANALYSIS },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("main, button");
});

test("a decision confirms and the queue moves on by itself", async ({ page }) => {
  await openResolve(page);
  await expect(page.getByText(/^Set 1 of 4/)).toBeVisible();

  // Real clicks: the copy sits under the pinned decision bar's shadow, and the
  // confirm button is inside that bar.
  await page.getByRole("button", { name: /^keep .*press 2$/i }).click();
  await page.getByRole("button", { name: "Confirm selection" }).click();

  await expect(page.getByText(/^Set 2 of 4/)).toBeVisible();
  await expect(page.getByText("1 of 4 decided")).toBeVisible();
});

test("bulk actions apply through the docked bar without moving the workspace", async ({ page }) => {
  await openResolve(page);
  const before = await page.locator('[data-stage-id="review"]').boundingBox();
  const heading = page.getByRole("heading", { level: 2 }).first();
  const headingBefore = await heading.boundingBox();

  await page.getByRole("button", { name: /^select all/i }).click();

  // The bar floats: selecting must not push the set being read down the page.
  expect((await heading.boundingBox())?.y).toBe(headingBefore?.y);
  expect((await page.locator('[data-stage-id="review"]').boundingBox())?.y).toBe(before?.y);

  await page.getByRole("button", { name: "Mark as not duplicates" }).click();
  await expect(page.getByText("4 of 4 decided")).toBeVisible();
  await expect(page.getByText(/every set has been decided/i)).toBeVisible();
});

test("comparing two copies keeps one, and the decision survives a restart", async ({ page }) => {
  await openResolve(page);
  await page.getByRole("button", { name: /^compare$/i }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // One keeper, chosen from a radio group rather than two toggles.
  // Named, not indexed: the comparison-mode selector is a radiogroup too, and
  // an index would silently pick "Overlay".
  await dialog.getByRole("radio", { name: /^B ·/ }).check();
  await dialog.getByRole("button", { name: "Confirm selection" }).click();

  await expect(page.getByText("1 of 4 decided")).toBeVisible();

  await page.reload();
  await expect(page.getByText("1 of 4 decided")).toBeVisible();
});
