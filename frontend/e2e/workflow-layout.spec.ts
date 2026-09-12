import { expect, test } from "@playwright/test";
import { stubBackend, openSurface, E2E_PREVIEW_RESULT, E2E_ANALYSIS } from "./support";

test("Setup names the active settings and makes detailed adjustments explicitly optional", async ({
  page,
}) => {
  await stubBackend(page);
  await page.goto("/");
  await openSurface(page, "recipe");
  await expect(page.locator("[data-current-settings]")).toContainText("Currently using:");
  await expect(page.locator("[data-optional-settings]")).toContainText("Optional:");
  const current = await page.locator("[data-current-settings]").textContent();
  await page.getByRole("button", { name: /clean up a library/i }).click();
  await expect(page.locator("[data-current-settings]")).toHaveText(current ?? "");
  await expect(page.getByRole("heading", { name: /Preview:/ })).toBeVisible();
});

test("Browse retains readable dates and status at compact widths in both languages", async ({
  page,
}) => {
  await stubBackend(page);
  await page.addInitScript(
    ({ result, analysis }) =>
      localStorage.setItem(
        "mediasort_completed_plan",
        JSON.stringify({
          schemaVersion: 3,
          planId: result.plan_id,
          configFingerprint: result.config_fingerprint,
          analysis,
        }),
      ),
    { result: E2E_PREVIEW_RESULT, analysis: E2E_ANALYSIS },
  );
  await page.goto("/");
  await openSurface(page, "review");
  await page.locator("[data-file-row]").first().waitFor({ state: "visible" });
  for (const language of ["en", "de"]) {
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/config") && response.request().method() === "POST",
    );
    await page.getByRole("combobox", { name: /language|sprache/i }).selectOption(language);
    await saved;
    await page.reload();
    await openSurface(page, "review");
    await page.locator("[data-file-row]").first().waitFor({ state: "visible" });
    for (const width of [360, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("[data-file-row]").first().waitFor({ state: "visible" });
      const cells = page.locator("[data-file-date], [data-file-status]");
      expect(await cells.count()).toBeGreaterThan(0);
      const clipped = await cells.evaluateAll((elements) =>
        elements.flatMap((el) => {
          const box = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const text = range.getBoundingClientRect();
          return box.height === 0 || text.left < box.left - 1 || text.right > box.right + 1
            ? [el.textContent]
            : [];
        }),
      );
      expect(clipped, `${language} at ${width}px`).toEqual([]);
    }
  }
  const destination = page.locator(
    '[data-file-row="/tmp/e2e-input/synthetic.heic"] [data-file-destination]',
  );
  await destination.scrollIntoViewIfNeeded();
  await destination.focus();
  await expect(page.locator("[data-tooltip]")).toContainText(
    (await destination.getAttribute("aria-label")) ?? "",
  );
  await page.keyboard.press("Escape");
  await page.locator("[data-open-plan]").click();
  await page
    .locator("main")
    .getByRole("button", { name: /weiter.*prüf/i })
    .click();
  await expect(page.locator("[data-file-row]").first()).toBeVisible();
});

test("workspace rails are symmetric and sticky settings meet the scrollport", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");
  await openSurface(page, "configure");
  for (const width of [360, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await Promise.all([
      page.locator("main > div").boundingBox(),
      page.locator("nav ol").boundingBox(),
      page.locator("footer > div").boundingBox(),
    ]);
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThan(1);
    }
    if (width === 1920) {
      expect(boxes.map((box) => box?.x)).toEqual([220, 220, 220]);
      await page.locator("main").evaluate((el) => (el.scrollTop = 600));
      const top = (await page.locator("main").boundingBox())?.y;
      await expect
        .poll(async () => (await page.locator("[data-setting-header]").first().boundingBox())?.y)
        .toBe(top);
    }
  }
});
