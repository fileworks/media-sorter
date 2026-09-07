import { expect, test } from "@playwright/test";
import { contrastViolations, stubBackend, openSurface } from "./support";

for (const theme of ["light", "dark"] as const) {
  for (const language of ["en", "de"] as const) {
    for (const width of [360, 1280]) {
      test(`local model setup is reachable without tagging: ${theme}, ${language}, ${width}px`, async ({
        page,
      }, testInfo) => {
        await stubBackend(page);
        await page.route("**/api/hardware", (route) =>
          route.fulfill({
            json: {
              logical_cpus: 8,
              total_ram_gb: 16,
              has_accelerator: true,
              recommended_tier: "standard",
              onnx_providers: ["CoreMLExecutionProvider"],
            },
          }),
        );
        await page.route("**/api/ai/models", (route) =>
          route.fulfill({
            json: {
              required_pack_id: "siglip-standard-v1",
              packs: [
                {
                  pack_id: "siglip-standard-v1",
                  display_name: "SigLIP Standard / Max",
                  state: "not_installed",
                  total_size: 412538967,
                  license: "Apache-2.0",
                  license_url: "https://example.invalid/license",
                  source: "https://huggingface.co",
                  task_id: null,
                  error: null,
                },
              ],
            },
          }),
        );
        await page.goto("/");
        await openSurface(page, "configure");
        await expect(page.locator("[data-open-recipes]")).toBeFocused();
        await page.locator("[data-open-recipes]").click();
        await expect(page.locator("[data-open-settings]")).toBeFocused();
        await page.locator("[data-open-settings]").click();
        await expect(page.locator("[data-open-recipes]")).toBeFocused();
        await page.getByRole("combobox", { name: "Language", exact: true }).selectOption(language);
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          theme === "dark",
        );
        const setup = page.locator("[data-local-ai-setup]");
        await expect(setup.locator("#ai-model-tier")).toHaveValue("auto");
        const install = setup.getByRole("button", {
          name: /^(Install model|Modell installieren)$/,
        });
        await install.scrollIntoViewIfNeeded();
        await expect(install).toBeVisible();
        await expect(page.locator("#ai-enabled")).not.toBeChecked();
        await expect(setup.locator("#ai-allow-gpu")).toBeChecked();
        await expect(setup).not.toContainText("3.2 GB");
        await expect(setup.locator("option[value=max]")).toContainText(
          language === "en" ? "same SigLIP 2" : "dasselbe SigLIP-2",
        );
        expect(await contrastViolations(page)).toEqual([]);
        for (const zoom of width === 360 ? ["1"] : ["1", "2"]) {
          await page.evaluate((value) => {
            document.documentElement.style.zoom = value;
          }, zoom);
          const overflow = await page
            .locator("main")
            .evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(overflow).toBeLessThanOrEqual(1);
          const clippedSegments = await page
            .locator("[data-segmented]")
            .evaluateAll(
              (controls) =>
                controls.filter((control) => control.scrollWidth > control.clientWidth + 1).length,
            );
          expect(clippedSegments).toBe(0);
        }
        await page.evaluate(() => {
          document.documentElement.style.zoom = "1";
        });
        await install.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath("local-ai.png"),
        });
      });
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`failed hardware detection is readable and can recover: ${theme}`, async ({ page }) => {
    await stubBackend(page);
    let failHardware = true;
    await page.route("**/api/hardware", (route) =>
      failHardware ? route.fulfill({ status: 503, body: "unavailable" }) : route.fallback(),
    );
    await page.goto("/");
    await openSurface(page, "configure");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    const setup = page.locator("[data-local-ai-setup]");
    const error = setup.getByRole("alert");
    await expect(error).toContainText("Could not detect local AI hardware");
    await error.scrollIntoViewIfNeeded();
    expect(await contrastViolations(page)).toEqual([]);
    failHardware = false;
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(setup.locator("#ai-model-tier")).toHaveValue("auto");
    await expect(error).toHaveCount(0);
  });
}
