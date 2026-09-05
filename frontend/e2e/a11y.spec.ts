import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  MIN_TARGET_PX,
  E2E_ANALYSIS,
  E2E_PREVIEW_RESULT,
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
  // The shell mounts behind a lazy boundary; wait for real content, not a spinner.
  await page.waitForSelector("main, [role='main'], button", { timeout: 30_000 });
  await expect(
    page.getByText(/something went wrong|unexpected error/i),
    "the app must render, not its ErrorBoundary — otherwise this suite audits an error screen",
  ).toHaveCount(0);
});

async function goToPlan(page: Page) {
  const configure = page.locator('[data-stage-id="configure"]');
  await expect(configure).toBeEnabled();
  await configure.click();
  await expect(configure).toHaveAttribute("aria-current", "step");
  const plan = page.locator('[data-stage-id="plan"]');
  await expect(plan).toBeEnabled();
  await plan.click();
  await expect(plan).toHaveAttribute("aria-current", "step");
}

async function goToReview(page: Page) {
  await goToPlan(page);
  const review = page.locator('[data-stage-id="review"]');
  await expect(review).toBeEnabled();
  await review.click();
  await expect(review).toHaveAttribute("aria-current", "step");
}

/**
 * Review opens on Browse — the first question after Plan is "what would this
 * run do", not "which of these copies do I keep". Reaching the decision queue
 * is a deliberate act, here as in the app.
 */
async function goToResolve(page: Page) {
  await goToReview(page);
  await page.getByRole("tab", { name: /decide the duplicates/i }).click();
  await expect(page.getByRole("tab", { name: /decide the duplicates/i })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

async function settleRendering(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getComputedTiming().iterations;
      return iterations !== Infinity;
    });
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function expectReducedMotion(page: Page) {
  const animated = await page.evaluate(() => {
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (
          style.animationName !== "none" ||
          style.transitionDuration.split(",").some((value) => parseFloat(value) !== 0) ||
          style.scrollBehavior !== "auto"
        ) {
          offenders.push(
            `${element.tagName}${pseudo ?? ""}: ${style.animationName}, ${style.transitionDuration}, ${style.scrollBehavior}`,
          );
        }
      }
    }
    return offenders;
  });
  expect(animated).toEqual([]);
}

/**
 * Whether the stage scroller is wider than the window it sits in.
 *
 * `layoutOverflow` below asks whether the *document* overflows, and the shell
 * is `overflow-hidden`, so a stage whose content is too wide for the window is
 * clipped rather than scrolled and never reaches the document at all. That is
 * the worse failure — content nobody can scroll to — and it is invisible to
 * that check. `<main>` is the only scroller, so measuring it is the question:
 * did this stage need more width than it was given?
 */
async function stageOverflow(page: Page) {
  return page.locator("main").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
}

async function layoutOverflow(page: Page) {
  return page.evaluate(() => ({
    document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    body: document.body.scrollWidth > document.body.clientWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.overflowX === "auto" || style.overflowX === "scroll") return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
  }));
}

async function expectTargetsAndFocus(page: Page, stage: string) {
  await settleRendering(page);
  const contrast = await contrastViolations(page);
  expect(contrast, `${stage}\n${JSON.stringify(contrast, null, 2)}`).toEqual([]);
  const undersized = await undersizedTargets(page);
  expect(
    undersized,
    `${stage}\n${undersized.map((target) => `${target.label} — ${target.width}x${target.height}`).join("\n")}`,
  ).toEqual([]);

  const obscured: string[] = [];
  let inspected = 0;
  await page.locator("main").focus();
  for await (const stop of tabStops(page, 18)) {
    void stop;
    inspected += 1;
    const hit = await focusObscuredBy(page);
    if (hit) obscured.push(`${hit.label} covered by ${hit.coveredBy}`);
  }
  expect(inspected, `${stage} must expose real keyboard stops`).toBeGreaterThan(0);
  expect(obscured, `${stage}\n${obscured.join("\n")}`).toEqual([]);
}

async function expectDetailFact(dialog: Locator, label: string, value: string | RegExp) {
  const term = dialog.locator("dt").filter({ hasText: label });
  await expect(term).toHaveCount(1);
  await expect(term.locator("xpath=following-sibling::dd[1]")).toHaveText(value);
}

async function openDetail(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = page.getByRole("button", { name, exact: true });
  const trigger =
    (await exact.count()) === 1
      ? exact
      : page.getByRole("button", { name: new RegExp(`^${escaped}(?:\\s|$)`) });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDetail(page: Page) {
  await page.getByRole("button", { name: /close/i }).last().click();
}

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
    test(`a failed review save keeps Retry legible on hover in ${theme}`, async ({ page }) => {
      await page.evaluate((value) => localStorage.setItem("mediasort_theme", value), theme);
      await page.reload();
      await goToReview(page);
      await page.route("**/api/sorting/plans/e2e-plan/review-state", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Save failed", code: "INTERNAL_ERROR" }),
        }),
      );
      await page.getByRole("tab", { name: /decide the duplicates/i }).click();
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      await expect(retry).toBeVisible();
      await retry.hover();
      await settleRendering(page);
      await expect(retry).toHaveCSS("opacity", "1");
      expect(await contrastViolations(page)).toEqual([]);
      await page.unroute("**/api/sorting/plans/e2e-plan/review-state");
      await retry.click();
      await expect(retry).toBeHidden();
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`text meets contrast in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
      }, theme);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await settleRendering(page);

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

  test("the focus walk distinguishes controls with the same visible label", async ({ page }) => {
    await page.evaluate(() => {
      for (const child of Array.from(document.body.children)) {
        if (child instanceof HTMLElement) child.inert = true;
      }
      const probe = document.createElement("div");
      probe.id = "focus-identity-probe";
      for (let index = 0; index < 2; index += 1) {
        const button = document.createElement("button");
        button.textContent = "Same label";
        probe.appendChild(button);
      }
      document.body.appendChild(probe);
    });

    let inspected = 0;
    for await (const stop of tabStops(page, 4)) {
      void stop;
      inspected += 1;
    }
    expect(inspected).toBe(2);
  });
});

test.describe("later stages", () => {
  test("every stage removes motion, including pseudo-elements and late-mounted progress", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await goToReview(page);
    for (const stage of ["sources", "recipe", "configure", "plan", "review"]) {
      await page.locator(`[data-stage-id="${stage}"]`).click();
      await expectReducedMotion(page);
    }
    await page.getByRole("tab", { name: /decide the duplicates/i }).click();
    await expectReducedMotion(page);
    await page
      .getByRole("button", { name: /^compare .* with /i })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: /compare copies/i })).toBeVisible();
    await expectReducedMotion(page);
    await page.getByRole("button", { name: /close/i }).last().click();
    await page.getByRole("button", { name: /these are not duplicates/i }).click();
    await page.getByRole("button", { name: /to execute/i }).click();
    await expectReducedMotion(page);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /execute the reviewed plan/i }).click();
    await expect(page.getByRole("heading", { name: /finished|done/i }).first()).toBeVisible();
    await expectReducedMotion(page);
  });

  test("reflow at 200% covers every stage including execute", async ({ page }) => {
    await goToResolve(page);
    await page.getByRole("button", { name: /these are not duplicates/i }).click();
    await page.getByRole("button", { name: /to execute/i }).click();
    for (const stage of ["sources", "recipe", "configure", "plan", "review", "execute"]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      if (stage === "execute") await page.getByRole("button", { name: /to execute/i }).click();
      else await page.locator(`[data-stage-id="${stage}"]`).click();
      // CSS zoom relays out text and controls; the existing CDP test separately
      // proves Chromium's visual-viewport page scale.
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      await settleRendering(page);
      expect(await layoutOverflow(page), `${stage} at 200%`).toMatchObject({
        document: false,
        body: false,
      });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1";
      });
      await page.setViewportSize({ width: 360, height: 800 });
      await settleRendering(page);
      expect(await layoutOverflow(page), `${stage} at 360px`).toMatchObject({
        document: false,
        body: false,
      });
    }
  });

  test("the media fixture reaches every screen, survives restart, and preserves evidence", async ({
    page,
  }) => {
    test.slow();
    await goToPlan(page);
    // The unit evidence is not on Plan. Plan answers "what would this run do",
    // in four numbers and a sequence; a per-file dump of every companion and
    // its warning is a different question, and it is asked where a single file
    // is being looked at — and once more in the preflight below, immediately
    // before the run that acts on those units.
    await expect(page.getByText(/media-unit evidence/i)).toHaveCount(0);
    await expectTargetsAndFocus(page, "Plan");
    await page
      .getByRole("button", { name: /to review|review/i })
      .last()
      .click();
    await expect(
      page.getByRole("heading", { name: /check the plan|review/i }).first(),
    ).toBeVisible();
    if (process.env.UPDATE_MEDIA_SORTER_SCREENSHOT === "1") {
      // The documented screenshot is the Review screen with its real plan in
      // it. Waiting only for the heading captured an empty, still-animating
      // page, and the button that was clicked to get here keeps focus — which
      // holds its tooltip open across the shot.
      await expect(page.getByRole("tab", { name: /decide the duplicates/i })).toBeVisible();
      await expect(page.getByText(/IMG_0001\.jpg/).first()).toBeVisible();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settleRendering(page);
      await page.screenshot({ path: "../docs/assets/screenshot.png", fullPage: false });
    }

    // Every committed real-format fixture must be inspectable in Chromium.
    // The facts below are intentionally read from the UI, not inferred from
    // file extensions or nearby API assertions.
    await page.getByRole("tab", { name: /browse the result/i }).click();
    let detail = await openDetail(page, "corrupt.jpg");
    await expectDetailFact(detail, "File type", "JPG");
    await expectDetailFact(detail, "Resolution", "unknown");
    await expectDetailFact(detail, "Goes to", "no destination");
    await expectDetailFact(detail, "Planned result", "Could not be read");
    await expectDetailFact(detail, "Protection", "Input — eligible for planned action");
    await expect(detail.getByText("No preview for this file")).toBeVisible();
    await closeDetail(page);

    await page.getByRole("button", { name: /show the contents of 08/i }).click();
    for (const fixture of [
      { name: "synthetic.heic", type: "HEIC" },
      { name: "synthetic.dng", type: "DNG" },
    ]) {
      detail = await openDetail(page, fixture.name);
      await expectDetailFact(detail, "File type", fixture.type);
      await expectDetailFact(detail, "Resolution", "3024 × 4032");
      await expectDetailFact(detail, "Protection", "Input — eligible for planned action");
      await closeDetail(page);
    }

    detail = await openDetail(page, "synthetic.mp4");
    await expectDetailFact(detail, "File type", "MP4");
    await expectDetailFact(detail, "Resolution", "unknown");
    await expectDetailFact(detail, "Duration", "unknown");
    await expectDetailFact(detail, "Video codec", "unknown");
    await expectDetailFact(detail, "Protection", "Input — eligible for planned action");
    await expect(
      detail
        .getByLabel("synthetic.mp4")
        .or(detail.getByRole("status", { name: /authenticated video|video preview/i })),
    ).toBeVisible();
    await closeDetail(page);

    await page.getByRole("tab", { name: /decide the duplicates/i }).click();
    // The ranking is folded away: the recommendation sentence is what the
    // reader needs, and six labelled fields above the copies were most of the
    // panel. Everything it used to state is still one click away.
    await expect(page.getByText(/primary rule/i)).toBeHidden();
    await page.getByText(/how this was ranked/i).click();
    await expect(page.getByText(/primary rule/i)).toBeVisible();
    await expect(page.getByText(/deciding fact/i)).toBeVisible();
    await expect(page.getByText(/unknown facts/i)).toBeVisible();
    await expect(page.getByText(/tie-break/i)).toBeVisible();
    await expect(page.getByText(/limitation/i)).toBeVisible();
    await expect(page.getByText(/modification date unknown.*IMG_0001-copy/i)).toBeVisible();
    await expectTargetsAndFocus(page, "Resolve");

    await openDetail(page, "IMG_0001.jpg");
    await expect(page.getByText(/primary in unit unit-live-photo/i)).toBeVisible();
    await expect(page.getByText(/IMG_0001\.xmp.*edit sidecar/i)).toBeVisible();
    await expectTargetsAndFocus(page, "Detail");
    await closeDetail(page);

    // Comparing is one press from the copy being compared, and its label names
    // the copy it would put beside it.
    await page
      .getByRole("button", { name: /^compare .* with /i })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: /compare copies/i })).toBeVisible();
    await expect(page.getByText(/primary in unit unit-live-photo/i)).toBeVisible();
    expect(await page.getByText("unknown", { exact: true }).count()).toBeGreaterThan(0);
    await expect(page.getByText(/0 × 0/)).toHaveCount(0);
    await expectTargetsAndFocus(page, "Compare");
    await page.getByRole("button", { name: /close/i }).last().click();

    await page.getByRole("button", { name: /these are not duplicates/i }).click();
    await expect(page.getByRole("button", { name: /to execute/i })).toBeEnabled();

    // A page reload recreates the renderer. The backend recovery proof and the
    // exact Review position plus the explicit keep-all decision must survive it.
    await page.reload();
    await expect(page.locator('[data-stage-id="review"]')).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("tab", { name: /decide the duplicates/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText(/every set has been decided/i)).toBeVisible();
    const persistedDecisions = await page.evaluate(async () => {
      const response = await fetch("http://127.0.0.1:8000/api/sorting/plans/e2e-plan/recovery");
      const recovery = (await response.json()) as {
        review_state: { decisions: Array<{ group_id: string; kind: string }> } | null;
      };
      return recovery.review_state?.decisions ?? null;
    });
    expect(persistedDecisions).toEqual([
      { group_id: "e2e-exact-set", kind: "keep_all", member_id: null },
    ]);

    await page.getByRole("button", { name: /to execute/i }).click();
    await expect(
      page.getByRole("heading", { name: /before this runs|execute/i }).first(),
    ).toBeVisible();
    await page.getByText(/media-unit evidence \(1\)/i).click();
    await expect(
      page.getByText(/IMG_0001\.mov.*motion component.*planned with the primary file/i),
    ).toBeVisible();
    await expectTargetsAndFocus(page, "Execute preflight");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /execute the reviewed plan/i }).click();

    await expect(page.getByRole("heading", { name: /finished|done/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("cell", { name: "IMG_0001.xmp", exact: true })).toBeVisible();
    await expect(page.getByText(/edit sidecar/i).first()).toBeVisible();
    await expect(page.getByText(/motion metadata remained unknown/i)).toBeVisible();
    const reportSearch = page.getByRole("searchbox");
    expect(await reportSearch.evaluate((element) => element.getBoundingClientRect().height)).toBe(
      32,
    );
    for (const { width, zoom } of [
      { width: 360, zoom: 1 },
      { width: 1280, zoom: 2 },
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await settleRendering(page);
      expect(await layoutOverflow(page), `Finished at ${width}px, zoom ${zoom}`).toMatchObject({
        document: false,
        body: false,
      });
      await expect(page.getByRole("button", { name: /^All \(/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectTargetsAndFocus(page, "Finished run");
  });

  test("360px and measured 200% Chromium page scale preserve reflow", async ({ page }) => {
    await goToResolve(page);
    await page.setViewportSize({ width: 360, height: 800 });
    const narrow = await layoutOverflow(page);
    expect(narrow, JSON.stringify(narrow, null, 2)).toMatchObject({ document: false, body: false });

    // Every stage, not only the one this test grew up around. A change to the
    // shared spacing scale or to a control's padding lands on all of them at
    // once, and the narrowest supported window is where that first shows.
    //
    // Navigation happens wide and measurement happens narrow: below `md` the
    // stepper draws only the active step, so the rail cannot be used to reach a
    // stage at the width the stage is being measured at.
    for (const stage of ["sources", "recipe", "configure", "plan", "review"] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      const rail = page.locator(`[data-stage-id="${stage}"]`);
      await expect(rail).toBeEnabled();
      await rail.click();
      await page.setViewportSize({ width: 360, height: 800 });
      await settleRendering(page);
      const overflow = await layoutOverflow(page);
      expect(overflow, `${stage} at 360px\n${JSON.stringify(overflow, null, 2)}`).toMatchObject({
        document: false,
        body: false,
      });
      const stageBox = await stageOverflow(page);
      expect(
        stageBox.scrollWidth,
        `${stage} needs ${stageBox.scrollWidth}px inside a ${stageBox.clientWidth}px window`,
      ).toBeLessThanOrEqual(stageBox.clientWidth);
    }
    await page.getByRole("tab", { name: /decide the duplicates/i }).click();

    await page
      .getByRole("button", { name: /^compare .* with /i })
      .first()
      .click();
    const comparison = page.getByRole("dialog", { name: /compare copies/i });
    await expect(comparison).toBeVisible();
    const comparisonBox = await comparison.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(comparisonBox.scrollWidth).toBe(comparisonBox.clientWidth);
    const comparedNarrow = await layoutOverflow(page);
    expect(comparedNarrow, JSON.stringify(comparedNarrow, null, 2)).toMatchObject({
      document: false,
      body: false,
    });
    await page.getByRole("button", { name: /close/i }).last().click();

    await page.setViewportSize({ width: 720, height: 800 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    const metrics = await cdp.send("Page.getLayoutMetrics");
    expect(metrics.visualViewport.scale).toBe(2);
    expect(metrics.visualViewport.clientWidth).toBe(360);
    const zoomed = await layoutOverflow(page);
    expect(zoomed, JSON.stringify(zoomed, null, 2)).toMatchObject({ document: false, body: false });
    await cdp.send("Emulation.resetPageScaleFactor");
  });

  test("stale recovery evidence is rejected after restart", async ({ page }) => {
    await page.route("**/api/sorting/plans/e2e-plan/recovery", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail: {
            code: "PLAN_STALE",
            message: "The destination changed after this plan was reviewed.",
          },
        }),
      });
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("mediasort_completed_plan")))
      .toBeNull();
    // Planning remains available so the user can recompute against the new
    // destination. Only the stale reviewed result must lose authority.
    await expect(page.locator('[data-stage-id="review"]')).toBeDisabled();
  });

  test("later screens pass target, keyboard, focus, locale, theme and width checks", async ({
    page,
  }) => {
    const cases = [
      { width: 360, locale: "de", theme: "dark", motion: "reduce" },
      { width: 768, locale: "en", theme: "light", motion: "no-preference" },
      { width: 1280, locale: "de", theme: "light", motion: "reduce" },
      { width: 1920, locale: "en", theme: "dark", motion: "no-preference" },
    ] as const;

    for (const item of cases) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({
        colorScheme: item.theme,
        reducedMotion: item.motion,
      });
      const languageSaved = page.waitForResponse(
        (response) =>
          response.url().includes("/api/config") && response.request().method() === "POST",
      );
      await page.getByRole("combobox", { name: /Language|Sprache/ }).selectOption(item.locale);
      await languageSaved;
      await page.evaluate(({ theme }) => {
        localStorage.setItem("mediasort_theme", theme);
      }, item);
      await page.reload();
      await goToReview(page);
      await page.setViewportSize({ width: item.width, height: 900 });
      await expect(page.locator("html")).toHaveAttribute("lang", item.locale);
      await expect(page.locator("html")).toHaveClass(
        item.theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );

      const overflow = await layoutOverflow(page);
      expect(
        overflow,
        `${JSON.stringify(item)}\n${JSON.stringify(overflow, null, 2)}`,
      ).toMatchObject({ document: false, body: false });
      expect(await contrastViolations(page), JSON.stringify(item)).toEqual([]);
      await expectTargetsAndFocus(page, `Review ${JSON.stringify(item)}`);
    }
  });

  test("the reset comparison stacks at 360px and its associated label activates", async ({
    page,
  }) => {
    const configure = page.locator('[data-stage-id="configure"]');
    await configure.click();
    await page.setViewportSize({ width: 360, height: 800 });
    await expectTargetsAndFocus(page, "Configure at 360px");
    await page.getByRole("button", { name: /edit settings/i }).click();
    await page.getByRole("button", { name: /discard and edit/i }).click();

    const input = page.locator("#remove-duplicates");
    await expect(input).toBeVisible();
    const id = await input.getAttribute("id");
    expect(id).not.toBeNull();
    const label = page.locator(`label[for="${id}"]`);
    await expect(label).toBeVisible();
    const before = await input.isChecked();
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/config") && response.request().method() === "POST",
    );
    await label.click();
    await saved;
    if (before) await expect(input).not.toBeChecked();
    else await expect(input).toBeChecked();

    await page.getByRole("button", { name: /settings overview/i }).click();
    await page.getByRole("button", { name: /reset all settings/i }).click();
    const region = page.getByRole("region", { name: /setting comparison/i });
    await expect(region).toBeVisible();
    const dimensions = await region.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      cards: element.querySelectorAll("article").length,
      visibleValues: (element.textContent ?? "").trim().length,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    expect(dimensions.cards).toBeGreaterThan(0);
    expect(dimensions.visibleValues).toBeGreaterThan(0);
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

  test("strict project policy rejects an isolated target despite spacing", async ({ page }) => {
    await page.evaluate((minimum) => {
      const probe = document.createElement("button");
      probe.id = "tiny-probe";
      probe.textContent = "x";
      probe.style.cssText = `width:${minimum - 8}px;height:${minimum - 8}px;padding:0;position:fixed;bottom:40px;right:40px`;
      document.body.appendChild(probe);
    }, MIN_TARGET_PX);
    await page.locator("#tiny-probe").waitFor({ state: "visible" });

    const undersized = await undersizedTargets(page);

    expect(undersized.some((t) => t.label === "x")).toBe(true);
  });

  test("an explicit associated label is the measured and working activation area", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "label-target-probe";
      input.type = "checkbox";
      input.style.cssText = "width:12px;height:12px";
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = "associated target probe";
      label.style.cssText =
        "position:fixed;bottom:24px;left:24px;display:flex;align-items:center;min-width:120px;min-height:32px;background:#fff;color:#000";
      document.body.append(input, label);
    });

    const input = page.locator("#label-target-probe");
    await page.getByText("associated target probe", { exact: true }).click();
    await expect(input).toBeChecked();
    expect((await undersizedTargets(page)).some((target) => target.label.includes("input#"))).toBe(
      false,
    );
  });
});
