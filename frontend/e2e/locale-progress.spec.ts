import { expect, test } from "@playwright/test";
import { stubBackend } from "./support";

test("interface language preserves a running scan identity and progress", async ({ page }) => {
  await stubBackend(page);
  let percentage = 37;
  const writes: string[] = [];
  const polls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(request.url());
  });
  await page.route("**/api/diagnostics", (route) =>
    route.fulfill({
      json: {
        recovery_operations: [],
        active_task: { task_id: "locale-scan", operation_kind: "analysis", status: "running" },
      },
    }),
  );
  await page.route("**/api/analysis/locale-scan**", (route) => {
    polls.push(route.request().url());
    return route.fulfill({
      json: {
        task_id: "locale-scan",
        operation_kind: "analysis",
        status: "running",
        progress: { current: percentage, total: 100, percentage, phase: "analyzing", outcomes: {} },
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
  await page.goto("/");
  const language = page.getByRole("combobox", { name: /language|sprache/i });
  await expect(language).toBeVisible();
  for (const locale of ["de", "en"]) {
    await language.selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.getByRole("button", { name: /operations|vorgänge/i, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String(percentage),
    );
    percentage = 62;
    await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");
    await page.keyboard.press("Escape");
  }
  expect(polls.length).toBeGreaterThan(1);
  expect(writes.filter((url) => /\/api\/(config$|analysis\/)/.test(url))).toEqual([]);
});
