import { expect, test, type Page } from "@playwright/test";

import { E2E_ANALYSIS, duplicatePlan, stubBackend, openSurface } from "./support";

/**
 * The duplicate workflow, driven the way a person drives it.
 *
 * Every assertion here is one jsdom cannot make. Resolve pins the set's state
 * and its two set-level decisions to the bottom of the pane; a control covered
 * by that band still receives a synthetic click in jsdom and reports success.
 * Real clicks refuse, which is the point of running this in a browser.
 */

const { groups, result } = duplicatePlan(3);

async function openResolve(page: Page) {
  await openSurface(page, "configure");
  await openSurface(page, "plan");
  await page.locator('[data-stage-id="review"]').click();
  // Review opens on Browse; the decision queue is reached deliberately.
  await page.getByRole("tab", { name: /decide the duplicates/i }).click();
  await expect(page.getByRole("button", { name: /^keep .*press 1$/i })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await stubBackend(page, { previewResult: result });
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
    { result, analysis: E2E_ANALYSIS },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector("main, button");
});

test("keeping a copy decides the set and the queue moves on by itself", async ({ page }) => {
  await openResolve(page);
  await expect(page.getByText(/Set 1 of 4/)).toBeVisible();

  // A real click: the copy sits under the pinned decision band's shadow, and
  // keeping it is the whole decision — there is no second control to press.
  await page.getByRole("button", { name: /^keep .*press 2$/i }).click();

  await expect(page.getByText(/Set 2 of 4/)).toBeVisible();
  await expect(page.getByText(/1 of 4 decided/)).toBeVisible();
});

test("bulk actions apply through the docked strip without moving the workspace", async ({
  page,
}) => {
  await openResolve(page);
  const before = await page.locator('[data-stage-id="review"]').boundingBox();
  const heading = page.getByRole("heading", { level: 2 }).first();
  const headingBefore = await heading.boundingBox();

  await page.getByRole("button", { name: /^select all/i }).click();

  // The bar floats: selecting must not push the set being read down the page.
  expect((await heading.boundingBox())?.y).toBe(headingBefore?.y);
  expect((await page.locator('[data-stage-id="review"]').boundingBox())?.y).toBe(before?.y);

  await page.getByRole("button", { name: "Decide these sets…" }).click();
  const bulk = page.getByRole("dialog", { name: /decide the selected sets/i });
  await expect(bulk).toBeVisible();
  // Stated on the control, not on hover: this is a decision over four sets.
  await expect(bulk.getByRole("button", { name: "Mark as not duplicates" })).toContainText(
    "4 of 4",
  );
  await bulk.getByRole("button", { name: "Mark as not duplicates" }).click();
  await expect(page.getByText(/4 of 4 decided/)).toBeVisible();
  await expect(page.getByText(/every set has been decided/i)).toBeVisible();
});

test("the control strip is the same height in both its states, at both widths", async ({
  page,
}) => {
  await openResolve(page);
  const strip = page.locator("[data-resolve-toolbar]");
  const heightOf = async () => Math.round((await strip.boundingBox())?.height ?? -1);

  // Measured, not assumed. Before the two states were drawn into one grid cell
  // they agreed at 1440 and disagreed by 114px at 360 — where the default
  // state wrapped to five rows and the selection state to three — so ticking a
  // checkbox pulled the list the checkbox was in up the page. jsdom cannot see
  // this: every element there is 0x0.
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(strip).toHaveAttribute("data-resolve-toolbar", "default");
    const before = await heightOf();
    expect(before).toBeGreaterThan(0);

    await page.getByRole("button", { name: /^select all/i }).click();
    await expect(strip).toHaveAttribute("data-resolve-toolbar", "selection");
    expect(await heightOf(), `strip resized at ${width}px`).toBe(before);

    await page.getByRole("button", { name: /clear set selection/i }).click();
    await expect(strip).toHaveAttribute("data-resolve-toolbar", "default");
    expect(await heightOf(), `strip resized returning to default at ${width}px`).toBe(before);
  }
});

test("comparing two copies keeps one, and the decision survives a restart", async ({ page }) => {
  await openResolve(page);
  // Comparing is one press from the copy being compared, and names its partner.
  await page
    .getByRole("button", { name: /^compare .* with /i })
    .first()
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // One keeper, chosen from a radio group rather than two toggles.
  // Named, not indexed: the comparison-mode selector is a radiogroup too, and
  // an index would silently pick "Overlay".
  await dialog.getByRole("radio", { name: /^B ·/ }).check();
  await expect(page.getByText(/saving this reviewed plan/i)).toHaveCount(0);
  const decisionSaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/sorting/plans/e2e-plan/review-state") &&
      response.request().method() === "PUT",
  );
  await dialog.getByRole("button", { name: "Confirm selection" }).click();

  await expect(page.getByText(/1 of 4 decided/)).toBeVisible();
  await decisionSaved;
  await expect(page.getByText(/saving this reviewed plan/i)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Applied", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Next set", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /^B ·/ })).not.toBeChecked();

  await page.reload();
  await expect(page.getByText(/1 of 4 decided/)).toBeVisible();
});

test("the pinned decision band is never painted over by the copies behind it", async ({ page }) => {
  await openResolve(page);

  // The band reports what the set has been decided to do. A copy row's own
  // controls sit above that row's fill; when a card established no stacking
  // context those z-indices competed page-wide and painted over the sticky
  // band, leaving the state unreadable under a filename. jsdom cannot see
  // this: nothing there is ever composited.
  const painted = await page.evaluate(() => {
    const status = [...document.querySelectorAll("strong")].find((element) =>
      /no copy chosen/i.test(element.textContent ?? ""),
    );
    if (!status) return { found: false, covering: null };
    const box = status.getBoundingClientRect();
    const topmost = document.elementsFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    )[0] as HTMLElement | undefined;
    return {
      found: true,
      covering:
        topmost && !topmost.contains(status) && topmost !== status
          ? (topmost.textContent ?? "").trim().slice(0, 60)
          : null,
    };
  });

  expect(painted.found).toBe(true);
  expect(painted.covering, "something is painted over the decision band's status").toBeNull();
});

test("Browse keeps decided copies in place, preserves recommendation, and searches filenames", async ({
  page,
}) => {
  await openResolve(page);
  await page.getByRole("tab", { name: /browse the result/i }).click();
  const search = page.getByRole("searchbox", { name: "Filter by filename…" });
  await search.fill("DSC_1001");
  const header = page.locator('[data-browse-set="dup-set-1"]');
  await header.getByRole("button", { expanded: false }).click();
  const card = page.locator('[data-copy-card="/tmp/e2e-input/DSC_1001.jpg"]');
  await expect(card.locator("[data-copy-recommended]")).toBeVisible();
  await card.getByRole("button", { name: "Keep this one", exact: true }).scrollIntoViewIfNeeded();
  const before = await card.boundingBox();
  await card.getByRole("button", { name: "Keep this one", exact: true }).click();
  await expect(card.getByRole("button", { name: "kept", exact: true })).toBeDisabled();
  await expect(card.locator("[data-copy-recommended]")).toBeVisible();
  expect((await card.boundingBox())?.y).toBe(before?.y);
  const actions = await page
    .locator("[data-copy-actions]")
    .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().bottom));
  expect(actions).toHaveLength(2);
  expect(actions[0]).toBe(actions[1]);
  await card.getByRole("checkbox").check();
  await expect(search).toBeVisible();
  await search.fill("no-such-photo");
  await expect(page.locator("[data-copy-card]")).toHaveCount(0);
});

test("keeping every copy retains the live Browse card until Refresh locations", async ({
  page,
}) => {
  await openResolve(page);
  await page.getByRole("tab", { name: /browse the result/i }).click();
  await page.getByRole("searchbox", { name: "Filter by filename…" }).fill("DSC_1001");
  await page
    .locator('[data-browse-set="dup-set-1"]')
    .getByRole("button", { expanded: false })
    .click();
  await page.getByRole("button", { name: "These are not duplicates", exact: true }).click();
  await expect(page.locator('[data-browse-set="dup-set-1"]')).toContainText("decided");
  await expect(page.locator("[data-copy-card]")).toHaveCount(2);
  await expect(page.locator("[data-file-row]")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh locations" }).click();
  await expect(page.locator("[data-copy-card]")).toHaveCount(0);
  await expect(page.locator("[data-file-row]")).toHaveCount(2);
});
