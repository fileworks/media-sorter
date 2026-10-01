import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const hover of [false, true]) {
    test(`input boundaries hold non-text contrast: ${theme}, hover ${hover}`, async ({ page }) => {
      await page.goto(`/e2e/fixtures/ui-controls.html?theme=${theme}`);
      const input = page.getByRole("textbox", { name: "Destination folder" });
      await expect(input).toBeVisible();
      if (hover) await input.hover();
      await expect
        .poll(async () =>
          input.evaluate((element) => {
            const style = getComputedStyle(element);
            const luminance = (color: string) => {
              const rgb = color
                .match(/[\d.]+/g)
                ?.slice(0, 3)
                .map(Number);
              if (!rgb || rgb.length !== 3) throw new Error(`Unmeasurable color: ${color}`);
              const linear = rgb.map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
            };
            const a = luminance(style.borderTopColor);
            const b = luminance(style.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }),
        )
        .toBeGreaterThanOrEqual(3);
    });
  }
}

for (const { width, zoom } of [
  { width: 320, zoom: 1 },
  { width: 1280, zoom: 2 },
]) {
  test(`long footer hints stay readable: width ${width}, zoom ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 360 });
    await page.goto("/e2e/fixtures/ui-controls.html");
    await page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, zoom);
    const trigger = page.getByRole("button", { name: "Explain output" });
    const anchor = await trigger.boundingBox();
    expect(anchor).not.toBeNull();
    expect(anchor!.y + anchor!.height).toBeGreaterThan(320);
    expect(anchor!.y + anchor!.height).toBeLessThanOrEqual(360);
    await trigger.hover();
    const hint = page.locator("[data-tooltip]");
    await expect(hint).toBeVisible();
    const rect = await hint.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(360);
    await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + Math.min(12, rect!.height / 2));
    await expect(hint).toBeVisible();
    await page.mouse.wheel(0, 50);
    await expect.poll(() => hint.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(hint).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hint).toHaveCount(0);
  });
}
