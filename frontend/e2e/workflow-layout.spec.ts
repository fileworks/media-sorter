import { expect, test } from "@playwright/test";
import {
  stubBackend,
  openSurface,
  E2E_PREVIEW_RESULT,
  E2E_ANALYSIS,
  tabStops,
  focusObscuredBy,
} from "./support";

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
  const configWrites: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/config") && request.method() === "POST") {
      configWrites.push(request.postData() ?? "");
    }
  });
  for (const language of ["en", "de"]) {
    await page.getByRole("combobox", { name: /language|sprache/i }).selectOption(language);
    // Changing interface language preserves the live plan; no config POST
    // can stale its fingerprint or clear the scan/preview/decisions.
    await expect(page.locator("[data-file-row]").first()).toBeVisible();
    expect(configWrites).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
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

test("companion badge glyphs stay inside their box at Windows-style scaling", async ({ page }) => {
  const result = { ...E2E_PREVIEW_RESULT, items: [E2E_PREVIEW_RESULT.items[0]] };
  await stubBackend(page, { previewResult: result });
  await page.route("**/api/review/groups**", (route) =>
    route.fulfill({
      json: {
        groups: [],
        next_cursor: null,
        kind: "exact",
        truncated: false,
        partial_index: false,
      },
    }),
  );
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
  await page.goto("/");
  await openSurface(page, "review");
  const badge = page.locator("[data-file-status]").getByText("moves together", { exact: true });
  await expect(badge).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const scale of [1, 1.25, 1.5, 2]) {
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, scale);
    await badge.scrollIntoViewIfNeeded();
    const clipped = await badge.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Missing badge text");
      const failures: string[] = [];
      for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const glyph = range.getBoundingClientRect();
        if (
          glyph.left < box.left ||
          glyph.right > box.right ||
          glyph.top < box.top ||
          glyph.bottom > box.bottom
        ) {
          failures.push(text.textContent?.[i] ?? "?");
        }
      }
      return failures;
    });
    expect(clipped, `clipped badge letters at ${scale * 100}%`).toEqual([]);
    await badge.screenshot({ path: test.info().outputPath(`badge-${scale}.png`) });
  }
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

for (const width of [640, 960]) {
  for (const locale of ["en", "de"]) {
    test(`settings keep keyboard focus below sticky headings: ${locale}, ${width}x406`, async ({
      page,
    }) => {
      await stubBackend(page);
      await page.addInitScript(
        ({ result, analysis, theme }) => {
          localStorage.setItem("mediasort_theme", theme);
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
        {
          result: E2E_PREVIEW_RESULT,
          analysis: E2E_ANALYSIS,
          theme: locale === "en" ? "light" : "dark",
        },
      );
      await page.goto("/");
      const language = page.getByRole("combobox", { name: /language|sprache/i });
      if ((await language.inputValue()) !== locale) {
        await language.selectOption(locale);

        await page.reload();
      }
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await openSurface(page, "recipe");
      await expect(page.locator("[data-open-settings]")).toBeVisible();
      await openSurface(page, "configure");
      // Actual Chromium tab zoom at 200% gives these CSS viewports for a
      // 1280/1920 x 900 window. The reduced height triggers focus scrolling;
      // the earlier 900px-high narrow-width checks never covered this case.
      await page.setViewportSize({ width, height: 406 });
      const editRules = page
        .locator("summary")
        .filter({ hasText: /edit rules|regeln bearbeiten/i });
      await expect(editRules).toBeVisible();
      await page.locator("main").focus();
      let reachedEditRules = false;
      const obscured: unknown[] = [];
      for await (const stop of tabStops(page, 18)) {
        void stop;
        reachedEditRules ||= await editRules.evaluate(
          (element) => element === document.activeElement,
        );
        const hit = await focusObscuredBy(page);
        if (hit) obscured.push(hit);
      }
      expect(reachedEditRules, "the keyboard walk must reach the affected action").toBe(true);
      expect(obscured).toEqual([]);
    });
  }
}

for (const locked of [false, true]) {
  for (const locale of ["en", "de"]) {
    test(`settings rail reaches a visible destination: ${locale}, ${locked ? "locked" : "editable"}`, async ({
      page,
    }) => {
      await stubBackend(page);
      if (locked) {
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
      }
      await page.goto("/");
      const language = page.getByRole("combobox", { name: /language|sprache/i });
      if ((await language.inputValue()) !== locale) {
        await language.selectOption(locale);

        await page.reload();
      }
      await openSurface(page, "recipe");
      await expect(page.locator("[data-open-settings]")).toBeVisible();
      await openSurface(page, "configure");
      await page.evaluate(() => document.fonts.ready);
      const row = page.locator("#setting-rules");
      const rules = row.locator("#rules-enabled");
      for (const width of [640, 1920]) {
        await page.setViewportSize({ width, height: width === 640 ? 406 : 900 });
        if (width === 640) {
          await page
            .getByRole("button", { name: /settings overview|einstellungsübersicht/i })
            .click();
        }
        const link = page
          .locator("nav")
          .getByRole("button", { name: /^(tagging rules|regeln)(\s|$)/i, includeHidden: true });
        await link.click();
        await expect
          .poll(async () =>
            row.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const main = document.querySelector("main")!.getBoundingClientRect();
              return box.top >= main.top + 80 && box.top < main.bottom - 40;
            }),
          )
          .toBe(true);
        await expect(link).toHaveAttribute("aria-current", "true");
        expect(await row.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
        expect(await focusObscuredBy(page)).toBeNull();
        if (locked) {
          await expect(rules).toBeDisabled();
          await expect(row).toBeFocused();
          const checked = await rules.isChecked();
          await page.keyboard.press("Space");
          expect(await rules.isChecked()).toBe(checked);
        } else {
          await expect(rules).toBeEnabled();
          await expect(rules).toBeFocused();
          const checked = await rules.isChecked();
          await page.keyboard.press("Space");
          await expect(rules).toBeChecked({ checked: !checked });
        }
        // The local-AI destination is a custom setup block, not a SettingRow.
        // It must support the same readable fallback when settings are locked.
        if (width === 640) {
          await page
            .getByRole("button", { name: /settings overview|einstellungsübersicht/i })
            .click();
        }
        const aiLink = page
          .locator("main nav")
          .getByRole("button", { name: /^(local ai|lokale ki)(\s|$)/i, includeHidden: true });
        const ai = page.locator("#setting-ai");
        await aiLink.click();
        // In a short editable pane, this large block's first field cannot fit
        // with the whole block aligned below the header. Check the field below;
        // ordinary and locked destinations retain their row anchor clearance.
        if (locked || width !== 640) {
          await expect
            .poll(async () =>
              ai.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const main = document.querySelector("main")!.getBoundingClientRect();
                return box.top >= main.top + 80 && box.top < main.bottom - 40;
              }),
            )
            .toBe(true);
        }
        await expect(aiLink).toHaveAttribute("aria-current", "true");
        expect(await ai.evaluate((element) => element.contains(document.activeElement))).toBe(true);
        await expect(ai).toHaveAccessibleName(locale === "en" ? "Local AI" : "Lokale KI");
        expect(await focusObscuredBy(page)).toBeNull();
        if (locked) await expect(ai).toBeFocused();
        else {
          // Hit testing a clipped intersection cannot prove the whole field is
          // visible. Navigation must leave its text and focus ring in the pane.
          await expect
            .poll(async () =>
              ai.evaluate(() => {
                const box = document.activeElement!.getBoundingClientRect();
                const main = document.querySelector("main")!.getBoundingClientRect();
                return box.top >= main.top + 80 && box.bottom <= main.bottom;
              }),
            )
            .toBe(true);
        }
      }
    });
  }
}
