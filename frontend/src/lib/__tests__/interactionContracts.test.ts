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
import ts from "typescript";
// @ts-expect-error Vitest supplies the Node runtime used by this test.
import { readFileSync } from "node:fs";
// The radius scale is declared in the Tailwind config; read it as text, the
// same way every other rule here is read, rather than importing an untyped JS
// module into a typechecked suite.
import tailwindConfigSource from "../../../tailwind.config.js?raw";
const cssSource = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

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

function sourceOf(path: string): string {
  return PRODUCT.find(([candidate]) => candidate === path)?.[1] ?? "";
}

function buttonAttributes(source: string): string[] {
  const tree = ts.createSourceFile(
    "surface.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const attributes: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "button") {
      attributes.push(node.attributes.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return attributes;
}

const RAW_BUTTONS = PRODUCT.map(([path, source]) => [path, buttonAttributes(source)] as const);

describe("stable workflow chrome", () => {
  it("shares one centered workspace frame across the content and both rails", () => {
    for (const path of [
      "src/components/StageShell.tsx",
      "src/components/shell/StageStepper.tsx",
      "src/components/shell/ActionBar.tsx",
    ]) {
      expect(sourceOf(path), path).toContain("workspace-frame");
      expect(sourceOf(path), path).not.toContain("max-w-workspace");
    }
    expect(cssSource).toMatch(
      /\.workspace-frame\s*\{\s*@apply mx-auto w-full max-w-workspace px-4 sm:px-6;/,
    );
    expect(sourceOf("src/components/StageShell.tsx")).toContain(
      'scrollbarGutter: "stable both-edges"',
    );
  });
  /**
   * The contract this replaces asked that the selection actions be `fixed`
   * out of document flow, so ticking a checkbox could not push the list the
   * checkbox was in. That solved the layout shift by floating a bar over the
   * page: centred on the window rather than on the pane it acted on, and on a
   * short window covering the rows it described.
   *
   * They live in the toolbar now — the row that already says what can be done
   * here — and swap in place. The shift is prevented by the strip reserving
   * its height, not by leaving the page.
   */
  it("keeps selection actions in the toolbar rather than floating over the page", () => {
    const toolbar = sourceOf("src/components/screens/review/ReviewToolbar.tsx");

    expect(toolbar).toContain("selectedCount > 0");
    expect(toolbar).not.toMatch(/className="[^"]*fixed[^"]*bottom-/);
    // And nothing in Review floats a bar over the action bar any more.
    for (const file of [
      "src/components/screens/review/ReviewToolbar.tsx",
      "src/components/screens/review/ResolveToolbar.tsx",
    ]) {
      expect(sourceOf(file), file).not.toContain("fixed inset-x-");
    }
  });

  it("uses the stage controls without a second progress indicator", () => {
    const stepper = sourceOf("src/components/shell/StageStepper.tsx");
    expect(stepper).not.toContain("scaleX(");
    expect(stepper).not.toContain("progress");
  });

  it("has no global Jump to command palette", () => {
    const main = sourceOf("src/pages/MainPage.tsx");
    expect(main).not.toContain('t("app.command")');
    expect(main).not.toContain("setCommandOpen");
  });
});

describe("the confirmation policy", () => {
  /**
   * The seven permitted cases, and where each one lives. Five are dialogs; the
   * other two are confirmations in a lighter form, which the policy allows —
   * what it forbids is confirming something a second press would undo.
   */
  it("confirms only what pressing the same button again cannot undo", () => {
    expect(filesMatching(/<ConfirmDialog\b/)).toEqual([
      // 1 · discarding a computed plan by moving back a stage
      "src/components/StageShell.tsx",
      // 7 · clearing every duplicate decision at once
      "src/components/screens/review/ResolveQueue.tsx",
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
    // If any of these ever grows a dialog it will show up as a new file here.
    //
    // The decision queue is the one review surface allowed a dialog, and only
    // for "clear all decisions": every other act in Review states itself where
    // it was taken and is undone by repeating it, but clearing all of them is
    // undone only by finding and re-deciding every set by hand. That is the
    // policy's own test — not "is this in Review", but "would a second press
    // undo it" — so the exception is named rather than the rule loosened.
    const reviewSurfaces = filesMatching(/<ConfirmDialog\b/).filter((path) =>
      path.includes("/review"),
    );
    expect(reviewSurfaces).toEqual(["src/components/screens/review/ResolveQueue.tsx"]);

    const queue = sourceOf("src/components/screens/review/ResolveQueue.tsx");
    // One dialog, and it is that one. A keeper choice must never grow one.
    expect(queue.match(/<ConfirmDialog\b/g)).toHaveLength(1);
    expect(queue).toContain('t("review.resolve.resetAll.title")');
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
  it("inspects attributes after arrow handlers instead of stopping at their greater-than sign", () => {
    expect(
      buttonAttributes(
        '<button onClick={() => save()} className="bg-primary" type="button">Save</button>',
      )[0],
    ).toContain('className="bg-primary"');
  });

  it("never dims text-bearing controls to communicate hover or disabled state", () => {
    expect(filesMatching(/\b(?:hover|disabled):opacity-(?!100\b)\d+/)).toEqual([]);
  });

  it("re-types no variant by hand", () => {
    // The four variants are declared once. A raw `<button>` painting itself
    // with a variant's own colours is a fifth definition that will drift.
    const offenders: string[] = [];
    for (const [path, buttons] of RAW_BUTTONS) {
      if (path === "src/components/ui/button.tsx") continue;
      for (const attributes of buttons) {
        if (/bg-primary\b[^"]*text-primary-foreground/.test(attributes)) {
          offenders.push(`${path}: a hand-painted primary`);
        }
        if (/bg-destructive\b/.test(attributes)) {
          offenders.push(`${path}: a hand-painted destructive`);
        }
        if (
          /\bborder-border\b/.test(attributes) &&
          /\bpx-3\b/.test(attributes) &&
          /\bpy-2\b/.test(attributes)
        ) {
          offenders.push(`${path}: a hand-painted outline`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every raw button an explicit type", () => {
    // A `<button>` inside a form defaults to `submit`, which navigates.
    const offenders: string[] = [];
    for (const [path, buttons] of RAW_BUTTONS) {
      for (const attributes of buttons) {
        if (!/\btype=/.test(attributes)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("spacing and semantic advice", () => {
  it("uses the shared form input for tag entry rather than a third control height", () => {
    for (const field of [
      "AiTagsInput",
      "CategoryTagsInput",
      "ExcludePatternTags",
      "RenameBuilder",
    ]) {
      const source = sourceOf(`src/components/config/fields/${field}.tsx`);
      expect(source).toContain("<Input");
      expect(source).not.toContain("<input");
      expect(source).not.toMatch(/\bh-(?:7|10)\b/);
    }
  });

  it("keeps padding, margins and gaps on whole steps, with only the 2px optical sub-step", () => {
    expect(filesMatching(/\b(?:[pm][trblxyse]?|gap(?:-[xy])?|space-[xy])-[1-9]\d*\.5\b/)).toEqual(
      [],
    );
  });

  it("presents a recommended recipe as advice", () => {
    const recipe = sourceOf("src/components/screens/RecipeGrid.tsx");
    const badge = /<span\s+data-recipe-recommendation\b[^>]*>/.exec(recipe)?.[0];
    expect(badge).toContain("bg-tint-suggest");
    expect(badge).toContain("text-suggest");
    expect(badge).not.toContain("success");
  });

  it("presents a recommended model tier as advice, not a completed choice", () => {
    const source = sourceOf("src/components/config/fields/AiEngine.tsx");
    const badge = /<span\s+data-tier-recommendation\b[^>]*>/.exec(source)?.[0];
    expect(badge).toContain("text-suggest");
    expect(badge).not.toContain("success");
  });

  it("uses one model selector for tagging and categorization", () => {
    const source = sourceOf("src/components/config/groups/EnrichGroup.tsx");
    expect(source).toContain("<ModelTierSelect");
    expect(source).not.toContain('name="ai-model-tier"');
    expect(source).not.toContain("tierCost");
  });
});

describe("motion has one scale and respects the system preference", () => {
  it("uses explicit transitions rather than animating arbitrary property changes", () => {
    expect(filesMatching(/\btransition-all\b/)).toEqual([]);
  });

  it("keeps entry, control, media and progress durations on the agreed scale", () => {
    expect(cssSource).toContain("animation: stage-enter 160ms ease both");
    expect(cssSource).toContain("transform: translateY(3px)");
    expect(sourceOf("src/components/ui/button.tsx")).toContain("duration-150");
    for (const component of ["toggle", "thumbnail", "media-image"]) {
      expect(sourceOf(`src/components/ui/${component}.tsx`)).toContain("duration-200");
    }
    expect(sourceOf("src/components/ui/progress.tsx")).toContain("duration-300");
    expect(sourceOf("src/components/screens/ExecuteScreen.tsx")).toContain("duration-500");
  });

  it("moves the indeterminate bar without laying out each animation frame", () => {
    const frames = cssSource.slice(
      cssSource.indexOf("@keyframes progress-indeterminate"),
      cssSource.indexOf(".progress-indeterminate"),
    );
    expect(frames).toContain("transform: translateX(");
    expect(frames).not.toMatch(/\b(?:left|right|width|height):/);
  });

  it("removes motion and smooth scrolling on elements and pseudo-elements", () => {
    const reduced = cssSource.slice(cssSource.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const rule of [
      "*::before",
      "*::after",
      "animation: none !important",
      "transition: none !important",
      "scroll-behavior: auto !important",
    ]) {
      expect(reduced).toContain(rule);
    }
  });
});

describe("one four-step workflow", () => {
  it("uses the same step scale outside the screen components too", () => {
    for (const [path, source] of PRODUCT) {
      for (const match of source.matchAll(/current:\s*(\d+),\s*total:\s*(\d+)/g)) {
        expect(Number(match[1]), path).toBeLessThanOrEqual(4);
        expect(Number(match[2]), path).toBe(4);
      }
    }
  });

  it("never directs readers to a retired fifth or sixth step", () => {
    const messages = readFileSync(new URL("../../i18n/messages.ts", import.meta.url), "utf8");
    expect(messages).not.toMatch(/(?:step|Schritt) [56]\b/);
  });

  it("keeps every surface header on the same four-step scale", () => {
    const screens: Record<string, number> = {
      SourcesScreen: 1,
      RecipeScreen: 2,
      ConfigureScreen: 2,
      ReviewScreen: 3,
      ReviewPlanLifecycle: 3,
      PlanScreen: 3,
      ExecuteScreen: 4,
    };
    for (const [screen, step] of Object.entries(screens)) {
      const source = sourceOf(`src/components/screens/${screen}.tsx`);
      const headers = [...source.matchAll(/<ScreenHeader\b[\s\S]*?\/>/g)];
      expect(headers.length, screen).toBeGreaterThan(0);
      for (const [header] of headers) {
        expect(header, screen).toContain(`current: ${step}, total: 4`);
      }
    }
  });
});

describe("one radius scale", () => {
  /**
   * `index.css` states the rule — "three steps, one job each, and no fourth" —
   * and `tailwind.config.js` maps every `rounded-*` utility onto one of them.
   * Neither could stop the two ways this drifted anyway.
   *
   * The first was spelling. Ten pixels could be written `rounded-md`,
   * `rounded-lg` or `rounded-panel`, and all three were in use, so reading a
   * className told you nothing about whether a row and a card were meant to
   * match. The semantic names win: they say which of the three jobs the
   * element is doing, which is the thing worth knowing.
   *
   * The second was the gap in the scale. `DEFAULT` was never mapped, so a bare
   * `rounded` was Tailwind's own 4px — the forbidden fourth radius, on 29
   * elements, most of them checkboxes.
   */
  const SPELLINGS = /\brounded-(?:[trblse]{1,2}-)?(sm|md|lg|xl|2xl)\b/g;

  it("writes each radius one way — control, panel, window", () => {
    const offenders: string[] = [];
    for (const [path, source] of PRODUCT) {
      for (const match of source.matchAll(SPELLINGS)) offenders.push(`${path}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("leaves no utility resolving to a fourth value", () => {
    const block = /borderRadius:\s*\{([^}]*)\}/.exec(tailwindConfigSource)?.[1] ?? "";
    const entries = [...block.matchAll(/^\s*"?([\w"-]+?)"?:\s*"([^"]+)",/gm)].map(
      ([, key, value]) => [key, value] as const,
    );

    expect(entries.length).toBeGreaterThan(0);
    // Every key, `DEFAULT` included, resolves to one of the three tokens.
    expect(new Set(entries.map(([, value]) => value))).toEqual(
      new Set(["var(--radius-control)", "var(--radius-panel)", "var(--radius-window)"]),
    );
    expect(Object.fromEntries(entries).DEFAULT).toBe("var(--radius-control)");
  });
});
