import { type Page, type Locator } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

/** axe-core's browser bundle, already a dependency of the vitest a11y suite. */
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8");

/** Minimum tap-target side in CSS pixels — WCAG 2.5.8 Level AA. */
export const MIN_TARGET_PX = 24;

export interface ContrastViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary: string | null }[];
}

/**
 * Run axe in the page, restricted to the rules jsdom cannot evaluate.
 *
 * Scoping to `color-contrast` is deliberate rather than lazy: running the full
 * rule set here would duplicate the vitest suite, and a duplicated assertion
 * that drifts is worse than one that lives in a single place.
 */
export async function contrastViolations(page: Page): Promise<ContrastViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    /** Only the shape this helper reads, so `any` is never needed. */
    interface AxeNode {
      target: string[];
      failureSummary?: string;
    }
    interface AxeViolation {
      id: string;
      impact?: string;
      help: string;
      nodes: AxeNode[];
    }
    interface AxeRun {
      run(context: Document, options: unknown): Promise<{ violations: AxeViolation[] }>;
    }
    const results = await (window as unknown as { axe: AxeRun }).axe.run(document, {
      runOnly: { type: "rule", values: ["color-contrast"] },
      resultTypes: ["violations"],
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary ?? null,
      })),
    }));
  });
}

export interface ObscuredTarget {
  label: string;
  coveredBy: string;
}

/**
 * WCAG 2.4.11 — is any part of the focused control covered by something else?
 *
 * Hit-testing the focused element's own corners and centre is what makes this a
 * *layout* check. A sticky header that overlaps a control only when the page is
 * scrolled is invisible to any test that reasons about the DOM alone, which is
 * precisely the failure this criterion exists for.
 */
export async function focusObscuredBy(page: Page): Promise<ObscuredTarget | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const box = active.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;

    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const cls =
        typeof element.className === "string" && element.className
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${tag}${id}${cls}`;
    };
    const label = (active.textContent ?? "").trim().slice(0, 40) || describe(active);

    // Inset by a pixel so a shared border does not read as an overlap.
    const points: [number, number][] = [
      [box.left + 1, box.top + 1],
      [box.right - 1, box.top + 1],
      [box.left + 1, box.bottom - 1],
      [box.right - 1, box.bottom - 1],
      [box.left + box.width / 2, box.top + box.height / 2],
    ];
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === active || active.contains(hit) || hit.contains(active)) continue;
      return { label, coveredBy: describe(hit) };
    }
    return null;
  });
}

export interface UndersizedTarget {
  label: string;
  width: number;
  height: number;
}

/**
 * WCAG 2.5.8 — every pointer target is at least 24x24 CSS pixels.
 *
 * Exempt, per the criterion itself: targets in a sentence of text, and controls
 * an equivalent of which exists elsewhere on the page. Neither exemption is
 * guessed at here — inline targets are detected by their line box, and anything
 * else that is genuinely exempt is expected to be listed by the caller.
 */
export async function undersizedTargets(
  page: Page,
  selector = "button, a[href], input, select, [role='button'], [role='tab'], [role='checkbox'], [role='switch']",
): Promise<UndersizedTarget[]> {
  return page.evaluate(
    ({ selector, minimum }) => {
      const out: { label: string; width: number; height: number }[] = [];
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const node = element as HTMLElement;
        // 2.5.8 measures the *target* — the region that accepts the pointer
        // action — not the painted control. A 16px checkbox inside a label that
        // activates it has the label's box as its target, and reporting the
        // input would be a false positive. Noise is how an a11y suite earns
        // being ignored, so the distinction is made here rather than waved at.
        const wrappingLabel = node.closest("label");
        const activation =
          wrappingLabel && (node.tagName === "INPUT" || node.tagName === "SELECT")
            ? wrappingLabel
            : node;
        const box = (activation as HTMLElement).getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue; // not rendered
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (node.hasAttribute("disabled")) continue;
        // Inline exemption: a link inside a run of text is explicitly excluded.
        if (style.display === "inline" && node.closest("p, li, span, label")) continue;
        if (box.width >= minimum && box.height >= minimum) continue;
        const text = (node.textContent ?? "").trim().slice(0, 40);
        const label =
          text ||
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          `${node.tagName.toLowerCase()}#${node.id || "?"}`;
        out.push({ label, width: Math.round(box.width), height: Math.round(box.height) });
      }
      return out;
    },
    { selector, minimum: MIN_TARGET_PX },
  );
}

/** Walk focus forward with Tab, yielding each stop. Bounded, so a focus trap ends the walk. */
export async function* tabStops(page: Page, limit = 60): AsyncGenerator<Locator> {
  const seen = new Set<string>();
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      return `${active.tagName}:${active.id}:${(active.textContent ?? "").trim().slice(0, 24)}`;
    });
    if (id === null) return;
    if (seen.has(id)) return; // cycled back to the start
    seen.add(id);
    yield page.locator(":focus");
  }
}

/**
 * Serve the whole API from the page's own network layer.
 *
 * In dev, `api.ts` falls back to 127.0.0.1:8000 when Tauri IPC is absent, so
 * this is where the app's requests actually go.
 */
export async function stubBackend(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    const url = route.request().url();
    const body = (payload: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    // Order matters: the more specific validate route must be matched before
    // the `/api/config` prefix that would otherwise swallow it.
    if (url.includes("/api/config/validate")) return body({ roots: [], settings: [] });
    if (url.includes("/api/config")) return body(await configPayload(page));
    if (url.includes("/api/review/groups"))
      return body({
        groups: [],
        next_cursor: null,
        kind: "exact",
        truncated: false,
        partial_index: false,
      });
    if (url.includes("/api/tasks")) return body([]);
    if (url.includes("/api/history")) return body([]);
    return body({});
  });
}

async function configPayload(page: Page): Promise<unknown> {
  // The app's own complete fixture, imported from the running dev server rather
  // than restated here. `SECTION_DEFAULTS` alone is not enough: the screens read
  // nested profiles like `library.roots` directly and throw without them, and a
  // stub that crashes the app into its ErrorBoundary would leave this suite
  // auditing an error screen while reporting success.
  return page.evaluate(async () => {
    const module = await import("/src/lib/__tests__/configFixture.ts");
    const base = (module as { TEST_CONFIG?: Record<string, unknown> }).TEST_CONFIG ?? {};
    const profile = (base.library_profile ?? {}) as Record<string, unknown>;
    const root = (root_id: string, role: string, path: string, priority: number) => ({
      root_id,
      role,
      path,
      display_name: null,
      priority,
      exclusions: [],
      identity: null,
    });
    // The fixture ships `roots: []`, which leaves the Sources stage incomplete
    // and every later stage disabled — so an audit using it unmodified can only
    // ever see the first screen. Populating a valid input/destination pair is
    // what lets this suite reach Configure at all.
    return {
      ...base,
      source_directory: "/tmp/e2e-input",
      target_directory: "/tmp/e2e-output",
      library_profile: {
        ...profile,
        roots: [
          root("input-1", "input", "/tmp/e2e-input", 0),
          root("dest-1", "destination", "/tmp/e2e-output", 1),
        ],
      },
    };
  });
}
