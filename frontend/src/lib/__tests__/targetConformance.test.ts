/**
 * P-12 / P-14 / P-15 / P-16 — `P1-UI-002`, asserted as source invariants.
 *
 * **The plan's first acceptance assertion cannot be written here, so it was
 * rewritten (§5.1).** It asks to "focus each control in a review list and assert
 * its bounding box is not covered by any `fixed`/`sticky` sibling". jsdom
 * performs no layout: `getBoundingClientRect()` returns zeros for every element,
 * and there is no stacking or overlap model. Such a test would pass whether or
 * not the overlap existed — the exact "test that cannot fail" this plan warns
 * about most. There is no Playwright in this repository to run it properly.
 *
 * What is checkable is the *mechanism* that prevents the overlap, which is what
 * the remediation actually installs. `scroll-padding-bottom` on the scroller and
 * `scroll-margin-top` on the rows are what the browser consults when it scrolls
 * something into view, so asserting they are present and sized is asserting the
 * thing that does the work.
 *
 * Likewise the 24x24 target rule: the sizes are Tailwind classes, so the
 * assertion is that no interactive control declares a sub-24px box without the
 * expanded hit area beside it.
 */

import { describe, expect, it } from "vitest";

import tailwindSource from "../../../tailwind.config.js?raw";

import { MIN_TARGET_24 } from "@/lib/a11y";

const SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(endsWith: string): string {
  const hit = Object.entries(SOURCES).find(([path]) => path.endsWith(endsWith));
  if (!hit) throw new Error(`${endsWith} not found — did it move?`);
  return hit[1];
}

/** Every surface whose rows sit under a sticky header. */
const LIST_SURFACES = [
  "screens/review/BrowsePane.tsx",
  "screens/review/DestinationTree.tsx",
  "ReportPanel.tsx",
  "ui/setting-row.tsx",
];

describe("the scroller reserves the floating action zone", () => {
  it("gives <main> a scroll padding at the bottom", () => {
    const shell = source("StageShell.tsx");

    expect(shell).toMatch(/scroll-pb-actionzone/);
  });

  it("sizes that padding from the shared token, not a loose number", () => {
    // Both the scroller and the toasts read one value, so they cannot drift.
    expect(source("StageShell.tsx")).toMatch(/scroll-pb-actionzone/);
    expect(source("ToastContext.tsx")).toMatch(/bottom-actionzone/);
  });

  it("defines the token as at least the action bar plus the selection bar", () => {
    const match = tailwindSource.match(/actionzone:\s*"([\d.]+)rem"/);

    expect(match).not.toBeNull();
    const value = Number(match?.[1]);

    // Action bar is 3.75rem and the selection bar floats above it at 4.5rem.
    expect(value).toBeGreaterThanOrEqual(7);
  });

  it("floats toasts above that zone rather than inside it", () => {
    const toasts = source("ToastContext.tsx");

    expect(toasts).toMatch(/bottom-actionzone/);
    expect(toasts).not.toMatch(/fixed inset-x-4 bottom-4/);
  });
});

describe("list rows clear their sticky header", () => {
  it.each(LIST_SURFACES)("%s gives its rows a scroll margin", (surface) => {
    expect(source(surface)).toMatch(/scroll-mt-/);
  });

  it("covers every surface that has a sticky header", () => {
    // Guards the list above from silently falling behind the code: a new sticky
    // header is a new surface, and it needs the same treatment.
    const withSticky = Object.entries(SOURCES)
      .filter(([path]) => !path.includes("__tests__"))
      .filter(([, text]) => /className=[^\n]*sticky top-0/.test(text))
      .map(([path]) => path);

    const missing = withSticky.filter((path) => !/scroll-mt-/.test(SOURCES[path]));

    expect(missing).toEqual([]);
  });
});

describe("small controls still have a large enough target", () => {
  it("expands the hit area wherever a 14px checkbox is used", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const [path, text] of Object.entries(SOURCES)) {
      if (path.includes("__tests__")) continue;
      // Each checkbox is judged by its own wrapper, not by a per-file count:
      // one adequately wrapped control must not excuse an unwrapped sibling.
      const pattern = /type="checkbox"/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const control = text.slice(match.index, match.index + 700);
        const small = /h-3\.5 w-3\.5/.test(control.slice(0, control.indexOf("/>") + 2));
        if (!small) continue;
        checked += 1;
        // The wrapper opens shortly before the input.
        const wrapper = text.slice(Math.max(0, match.index - 700), match.index);
        if (!/MIN_TARGET_24|min-h-6/.test(wrapper)) {
          offenders.push(`${path}: a 14px checkbox with no expanded target`);
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("defines the expanded target at the required size", () => {
    // h-6/w-6 is 1.5rem = 24px, the SC 2.5.8 minimum, centred on the control.
    expect(MIN_TARGET_24).toContain("before:h-6");
    expect(MIN_TARGET_24).toContain("before:w-6");
    expect(MIN_TARGET_24).toContain("before:-translate-x-1/2");
    expect(MIN_TARGET_24).toContain("before:-translate-y-1/2");
    expect(MIN_TARGET_24).toContain("relative");
  });
});

describe("the focus trap only offers real tab stops", () => {
  it("excludes every disabled control, not only buttons", () => {
    const trap = source("useFocusTrap.ts");

    for (const tag of ["input", "select", "textarea", "button"]) {
      expect(trap).toContain(`${tag}:not([disabled])`);
    }
  });

  it("still offers the enabled ones", () => {
    const trap = source("useFocusTrap.ts");

    expect(trap).toContain("a[href]");
    expect(trap).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe("the selection count announces without swallowing its controls", () => {
  it("keeps the live region a sibling of the buttons", () => {
    // The bar moved into the toolbar, but the shape of the announcement did
    // not: a region *around* the controls re-reads every label — each button,
    // each disabled reason — on every selection change.
    const toolbar = source("ReviewToolbar.tsx");

    expect(toolbar).toMatch(/<span\s+role="status"\s+aria-live="polite"/);
    expect(toolbar).not.toMatch(/<div[^>]*aria-live/);
  });

  it("mounts that region in both states so the first selection is an update", () => {
    const toolbar = source("ReviewToolbar.tsx");
    // Rendered once and referenced from both branches, holding "" until there
    // is something to say: a region that appears together with its content is
    // frequently not announced at all.
    expect(toolbar).toMatch(/selectedCount > 0 \? t\("review\.selected"/);
    expect((toolbar.match(/\{announcement\}/g) ?? []).length).toBe(2);
  });
});

describe("progress is announced by phase, not by percentage", () => {
  it("does not put a live region on the percentage", () => {
    const execute = source("ExecuteScreen.tsx");
    const percentage = execute.indexOf("text-4xl font-bold tracking-tight");
    const block = execute.slice(percentage, percentage + 400);

    expect(block.slice(0, block.indexOf("</span>"))).not.toMatch(/aria-live/);
  });

  it("puts it on the phase label instead", () => {
    const execute = source("ExecuteScreen.tsx");

    expect(execute).toMatch(/text-sm font-semibold text-foreground" aria-live="polite"/);
  });
});
