import { expect, test, type Page } from "@playwright/test";
import { E2E_ANALYSIS, E2E_PREVIEW_RESULT, stubBackend } from "./support";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function recordFirstScreens(page: Page) {
  await page.addInitScript(() => {
    const headings: string[] = [];
    (window as unknown as { initialHeadings: string[] }).initialHeadings = headings;
    new MutationObserver(() => {
      const heading = document.getElementById("current-stage-heading");
      if (heading?.textContent) headings.push(heading.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

for (const stop of ["plan", "review"] as const) {
  test(`startup restores the saved ${stop} before showing the workflow`, async ({ page }) => {
    await stubBackend(page);
    await recordFirstScreens(page);
    await page.addInitScript(
      ({ result, analysis, stop }) => {
        localStorage.setItem(
          "mediasort_completed_plan",
          JSON.stringify({
            schemaVersion: 3,
            planId: result.plan_id,
            configFingerprint: result.config_fingerprint,
            analysis,
          }),
        );
        localStorage.setItem(`mediasort_review_stop:${result.plan_id}`, stop);
      },
      { result: E2E_PREVIEW_RESULT, analysis: E2E_ANALYSIS, stop },
    );
    const requested = barrier();
    const recovery = barrier();
    await page.route("**/api/sorting/plans/e2e-plan/recovery", async (route) => {
      requested.release();
      await recovery.promise;
      await route.fallback();
    });
    try {
      await page.goto("/");
      await requested.promise;
      await expect(page.getByText("Restoring previous progress", { exact: true })).toBeVisible();
      await expect(page.locator("#current-stage-heading")).toHaveCount(0);
      recovery.release();
      await expect(page.locator('[data-stage-id="review"]')).toHaveAttribute(
        "aria-current",
        "step",
      );
      await expect(page.locator("#current-stage-heading")).toHaveText(
        stop === "plan" ? "Plan calculated" : "Check the plan",
      );
      const headings = await page.evaluate(
        () => (window as unknown as { initialHeadings: string[] }).initialHeadings,
      );
      expect(headings.length).toBeGreaterThan(0);
      expect(headings.some((heading) => /sources|choose folders/i.test(heading))).toBe(false);
    } finally {
      recovery.release();
    }
  });
}

test("startup waits for the running scan's first progress snapshot", async ({ page }) => {
  await stubBackend(page);
  await recordFirstScreens(page);
  const diagnostics = barrier();
  const status = barrier();
  const polled = barrier();
  await page.route("**/api/diagnostics", async (route) => {
    await diagnostics.promise;
    await route.fulfill({
      json: {
        recovery_operations: [],
        active_task: { task_id: "startup-scan", operation_kind: "analysis", status: "running" },
      },
    });
  });
  await page.route("**/api/analysis/startup-scan**", async (route) => {
    polled.release();
    await status.promise;
    await route.fulfill({
      json: {
        task_id: "startup-scan",
        operation_kind: "analysis",
        status: "running",
        progress: { current: 37, total: 100, percentage: 37, phase: "analyzing", outcomes: {} },
        partial: false,
        issues: [],
        events: [],
        last_event_sequence: 0,
        result: null,
        error: null,
        failure: null,
      },
    });
  });
  try {
    await page.goto("/");
    await expect(page.getByText("Restoring previous progress", { exact: true })).toBeVisible();
    await expect(page.locator("#current-stage-heading")).toHaveCount(0);
    diagnostics.release();
    await polled.promise;
    await expect(page.getByText("Restoring previous progress", { exact: true })).toBeVisible();
    await expect(page.locator("#current-stage-heading")).toHaveCount(0);
    status.release();
    await expect(page.locator('[data-stage-id="review"]')).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "37");
    const headings = await page.evaluate(
      () => (window as unknown as { initialHeadings: string[] }).initialHeadings,
    );
    expect(headings.some((heading) => /sources|choose folders/i.test(heading))).toBe(false);
  } finally {
    diagnostics.release();
    status.release();
  }
});

test("a failed initial session check offers reload instead of opening a fresh workflow", async ({
  page,
}) => {
  await stubBackend(page);
  await page.route("**/api/diagnostics", (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Previous progress could not be checked");
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(page.locator("#current-stage-heading")).toHaveCount(0);
});
