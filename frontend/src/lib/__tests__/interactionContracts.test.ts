/**
 * The interaction rules, enforced instead of audited.
 *
 * `unify-interaction-primitives` settled four questions — which actions may be
 * confirmed, what a dialog is built on, what a native `title` is allowed to do,
 * and whether a backdrop may blur. Each was answered once by reading every file.
 * That answer goes stale the first time somebody adds a screen, so it is
 * asserted here against the tree rather than written down as prose.
 */

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every product file, with `../../` stripped to a path that reads as itself. */
const PRODUCT = Object.entries(SOURCES)
  .filter(([path]) => !path.includes("__tests__") && !path.includes(".test."))
  // The catalogue is data, not interface: it holds the text of every message
  // key and would match every pattern below.
  .filter(([path]) => !path.endsWith("i18n/messages.ts"))
  .map(([path, source]) => [path.replace(/^\.\.\/\.\.\//, "src/"), source] as const);

function filesMatching(pattern: RegExp): string[] {
  return PRODUCT.filter(([, source]) => pattern.test(source))
    .map(([path]) => path)
    .sort();
}

describe("the confirmation policy", () => {
  /**
   * The six permitted cases, and where each one lives. Four are dialogs; the
   * other two are confirmations in a lighter form, which the policy allows —
   * what it forbids is confirming something a second press would undo.
   */
  it("confirms only what pressing the same button again cannot undo", () => {
    expect(filesMatching(/<ConfirmDialog\b/)).toEqual([
      // 1 · discarding a computed plan by moving back a stage
      "src/components/StageShell.tsx",
      // 3 · a configuration reset · 4 · cancelling a running operation
      "src/pages/MainPage.tsx",
    ]);

    // 3 also, in its own shape: the reset dialog states what it would change.
    expect(filesMatching(/<ResetDialog\b/)).toContain("src/components/screens/ConfigureScreen.tsx");
    // 5 · executing, as an acknowledgement rather than a dialog.
    expect(filesMatching(/acknowledgedSourceMutations/)).toContain(
      "src/components/OperationCenter.tsx",
    );
    // 6 · clearing run history, as a two-step in place.
    expect(filesMatching(/history\.confirmDelete/)).toEqual(["src/components/HistoryPanel.tsx"]);
  });

  it("never confirms an action the interface can visibly undo", () => {
    // Exclude, include, dissolve, change a keeper, switch a filter or a view.
    // If any of these ever grows a dialog it will show up as a new file above.
    const reviewSurfaces = filesMatching(/<ConfirmDialog\b/).filter((path) =>
      path.includes("/review"),
    );
    expect(reviewSurfaces).toEqual([]);
  });
});

describe("one dialog mechanism", () => {
  it("builds every dialog on the shared shell", () => {
    const dialogs = filesMatching(/<Modal\b/).filter(
      (path) => path !== "src/components/ui/modal.tsx",
    );

    expect(dialogs.length).toBeGreaterThan(0);
    for (const path of dialogs) {
      const source = PRODUCT.find(([candidate]) => candidate === path)?.[1] ?? "";
      expect(source, path).toContain('from "@/components/ui/modal"');
    }
  });

  it("lets nothing else portal, trap focus, or answer Escape for itself", () => {
    expect(filesMatching(/createPortal/)).toEqual([
      "src/components/ui/modal.tsx",
      "src/components/ui/tooltip.tsx",
    ]);
    expect(filesMatching(/useFocusTrap/)).toEqual([
      "src/components/ui/modal.tsx",
      "src/hooks/useFocusTrap.ts",
    ]);
  });

  it("draws no blurred scrim behind a dialog", () => {
    // A blurred dialog backdrop reads as a rendering fault rather than as
    // depth; the scrim carries the separation instead. A frosted sticky table
    // header is a different thing and is left alone, so the rule is scoped to
    // full-viewport overlays rather than to the class name.
    const offenders: string[] = [];
    for (const [path, source] of PRODUCT) {
      for (const match of source.matchAll(/className=\{?"([^"]*)"/g)) {
        const classes = match[1];
        if (/fixed inset-0/.test(classes) && /backdrop-blur/.test(classes)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("native title", () => {
  /**
   * A native `title` survives for exactly one purpose: revealing the full value
   * of text that is visibly truncated. It never appears for a keyboard user,
   * never appears at all on a disabled control, and looks different on every
   * platform — so anywhere else it is either a lie or a hidden requirement.
   */
  it("appears only beside a truncation", () => {
    const offenders: string[] = [];
    for (const [path, source] of PRODUCT) {
      // JSX `title={…}` on a lowercase (DOM) element. Component props named
      // `title` — Modal, StateView, SettingGroup — are a different thing.
      for (const match of source.matchAll(/<([a-z][a-zA-Z0-9]*)\b([^>]*?)>/gs)) {
        const [, tag, attributes] = match;
        if (!/\btitle=\{/.test(attributes)) continue;
        if (!/truncate|break-all|line-clamp/.test(attributes)) {
          offenders.push(`${path}: <${tag}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("button variants", () => {
  it("re-types no variant by hand", () => {
    // The four variants are declared once. A raw `<button>` painting itself
    // with a variant's own colours is a fifth definition that will drift.
    const offenders: string[] = [];
    for (const [path, source] of PRODUCT) {
      if (path === "src/components/ui/button.tsx") continue;
      for (const match of source.matchAll(/<button\b([^>]*?)>/gs)) {
        const attributes = match[1];
        if (/bg-primary\b[^"]*text-primary-foreground/.test(attributes)) {
          offenders.push(`${path}: a hand-painted primary`);
        }
        if (/bg-destructive\b/.test(attributes)) {
          offenders.push(`${path}: a hand-painted destructive`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every raw button an explicit type", () => {
    // A `<button>` inside a form defaults to `submit`, which navigates.
    const offenders: string[] = [];
    for (const [path, source] of PRODUCT) {
      for (const match of source.matchAll(/<button\b([^>]*?)>/gs)) {
        if (!/\btype=/.test(match[1])) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
