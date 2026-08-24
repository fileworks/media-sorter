import { describe, expect, it } from "vitest";
import ts from "typescript";
import operationCenterSource from "@/components/OperationCenter.tsx?raw";
import sourcesScreenSource from "@/components/screens/SourcesScreen.tsx?raw";
import configureScreenSource from "@/components/screens/ConfigureScreen.tsx?raw";
import reviewScreenSource from "@/components/screens/ReviewScreen.tsx?raw";
import executeScreenSource from "@/components/screens/ExecuteScreen.tsx?raw";
import compareModalSource from "@/components/screens/review/CompareModal.tsx?raw";
import destinationTreeSource from "@/components/screens/review/DestinationTree.tsx?raw";
import recipeGridSource from "@/components/screens/RecipeGrid.tsx?raw";
import recipeScreenSource from "@/components/screens/RecipeScreen.tsx?raw";
import runLogSource from "@/components/screens/RunLog.tsx?raw";
import titleBarSource from "@/components/shell/TitleBar.tsx?raw";
import stageStepperSource from "@/components/shell/StageStepper.tsx?raw";
import { catalogs, de, en } from "@/i18n/messages";
import { plural, storedLocale, translate } from "@/i18n/I18nContext";
import { formatBytes, formatCount, formatDuration } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";

/**
 * Every source file, so key usage can be checked against the catalogue rather
 * than against a hand-maintained list that goes stale the moment a file moves.
 */
const RAW_SOURCES = {
  ...(import.meta.glob("../../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  // The browser suite names keys too, and a key it builds from a template is
  // still a key nothing may delete.
  ...(import.meta.glob("../../../e2e/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
};

/** Surfaces `remove-unreachable-frontend-surfaces` deleted outright. */
const REMOVED_NAMESPACES = [
  "quarantine.",
  "audit.",
  "reconcile.",
  "bursts.",
  "catalog.",
  "validation.",
  // Review's four tabs, its junk and warnings panels, and its shortcut sheet.
  // The rework replaced all of them with one item surface.
  "view.",
  "review.junk.",
  "review.warnings.",
  "review.shortcut",
];

// `import.meta.glob` keys are relative to this file, so the catalogue arrives
// as `../messages.ts`: the old `includes("i18n/messages.ts")` filter matched
// nothing and every key silently counted as a mention of itself.
const ALL_SOURCES = Object.entries(RAW_SOURCES).filter(
  ([path]) => !path.endsWith("i18n/messages.ts") && !path.endsWith("../messages.ts"),
);

const PRODUCT_SOURCES = ALL_SOURCES.filter(([path]) => !path.includes("__tests__"));

/**
 * Keys named by a string literal at a `t(...)` or `translate(...)` call site.
 *
 * Deliberately not every dotted string in the tree: `"config.json"` and
 * `"app.tsx"` are not keys. Keys built from a template — `` t(`config.keeper.${id}`) ``
 * — use backticks and so never match here; they are covered by the prefix scan
 * below, which is why a literal search alone must never drive a deletion.
 */
function literalKeyReferences(): Set<string> {
  const keys = new Set<string>();
  for (const [, source] of PRODUCT_SOURCES) {
    for (const match of source.matchAll(/\bt(?:Count)?\(\s*"([^"]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/\btranslate\(\s*[^,()]+,\s*"([^"]+)"/g))
      keys.add(match[1]);
  }
  return keys;
}

/**
 * Every catalogue key named anywhere by a quoted string.
 *
 * Broader than {@link literalKeyReferences} on purpose: this one decides what
 * may be *deleted*, and a key is also named where it is stored rather than
 * where it is resolved — `labelKey: "recipes.scratch.label"`, or the
 * `cannotKey="review.bulk.cannotRule"` a component passes down. Missing one of
 * those and deleting the key would leave the interface rendering the key.
 */
function quotedKeyMentions(): Set<string> {
  const mentions = new Set<string>();
  for (const [, source] of ALL_SOURCES) {
    for (const match of source.matchAll(/["'`]([a-zA-Z][a-zA-Z0-9._-]*)["'`]/g)) {
      mentions.add(match[1]);
    }
  }
  return mentions;
}

/** Prefixes of keys assembled at runtime, e.g. `` `config.keeper.${id}` `` . */
function templateKeyPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const [, source] of ALL_SOURCES) {
    for (const match of source.matchAll(/`([a-zA-Z][a-zA-Z0-9_.]*\.)\$\{/g)) prefixes.add(match[1]);
  }
  return prefixes;
}

describe("English/German resources", () => {
  it("have exact non-empty key parity", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), `English ${key}`).not.toBe("");
      expect(de[key].trim(), `German ${key}`).not.toBe("");
    }
  });

  it("keeps no key belonging to a deleted surface", () => {
    const survivors = Object.keys(en).filter((key) =>
      REMOVED_NAMESPACES.some((namespace) => key.startsWith(namespace)),
    );

    expect(survivors).toEqual([]);
  });

  it("resolves every key the interface asks for by name", () => {
    const catalogue = new Set(Object.keys(en));
    const missing = [...literalKeyReferences()].filter(
      (key) =>
        !catalogue.has(key) &&
        // A dotted literal at a t()/translate() call site that is not a key is
        // a caller passing a fallback string, which is allowed.
        /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(key),
    );

    expect(missing, "keys used by the interface but absent from the catalogue").toEqual([]);
  });

  it("carries no key the interface never asks for", () => {
    // The catalogue drifted to a quarter dead weight once, because nothing
    // could tell a key that is resolved at runtime from one whose surface was
    // deleted years ago. Both rules below are deliberately generous — a key
    // survives on any mention at all — so a failure here is a key with no
    // remaining reader, not a scanning artefact.
    const mentioned = quotedKeyMentions();
    const prefixes = [...templateKeyPrefixes()];
    const orphaned = Object.keys(en).filter((key) => {
      if (mentioned.has(key)) return false;
      if (prefixes.some((prefix) => key.startsWith(prefix))) return false;
      // `plural()` resolves `key.one` from the base key alone.
      return !(key.endsWith(".one") && mentioned.has(key.slice(0, -".one".length)));
    });

    expect(orphaned, "catalogue keys nothing reads — delete them").toEqual([]);
  });

  it("states counts in words, never as a bracketed suffix", () => {
    // "1 file(s)" is a sentence nobody writes for one reader and one language.
    // The catalogue carries `key` and `key.one` instead, and `tCount` picks.
    // This is a gate because a grep for it is easy to get wrong: the suffix
    // hides mid-sentence as readily as it sits at the end.
    // Both catalogues, separately: they share every key, so spreading one over
    // the other would check the second and silently skip the first.
    const bracketed: string[] = [];
    for (const [language, catalogue] of [
      ["en", en],
      ["de", de],
    ] as const) {
      for (const [key, text] of Object.entries(catalogue)) {
        if (/\((s|n|e|en|es)\)/.test(text)) bracketed.push(`${language}: ${key}`);
      }
    }

    expect(bracketed).toEqual([]);
  });

  it("pairs every singular form with the plural it belongs to", () => {
    const catalogue = new Set(Object.keys(en));
    const singulars = Object.keys(en).filter((entry) => entry.endsWith(".one"));

    expect(singulars.length).toBeGreaterThan(0);
    for (const key of singulars) {
      expect(catalogue.has(key.slice(0, -".one".length)), `${key} without its plural`).toBe(true);
      expect(key in de, `${key} missing from the German catalogue`).toBe(true);
    }
  });

  it("picks the singular for exactly one and the plural for anything else", () => {
    for (const locale of ["en", "de"] as const) {
      expect(plural(locale, "review.setSelection.count", 1)).toBe(
        catalogs[locale]["review.setSelection.count.one"],
      );
      expect(plural(locale, "review.setSelection.count", 2)).toContain("2");
      expect(plural(locale, "review.setSelection.count", 0)).toContain("0");
    }
    // A key with no singular form still renders rather than resolving to itself.
    expect(plural("en", "review.stack.copies", 1)).toBe("1 copies");
    // And a call site may format the count it shows without losing the form.
    expect(plural("en", "review.browse.folderCount", 1200, { count: "1,200" })).toBe(
      "1,200 entries",
    );
  });

  it("keeps every runtime-assembled key family populated", () => {
    const keys = Object.keys(en);
    const i18nPrefixes = [...templateKeyPrefixes()].filter((prefix) =>
      keys.some((key) => key.startsWith(prefix)),
    );

    // Guards task 5.3: these families are built at runtime, so a literal search
    // reports them as unreferenced. Deleting one would break silently.
    expect(i18nPrefixes.length).toBeGreaterThan(0);
    for (const prefix of i18nPrefixes) {
      expect(
        keys.filter((key) => key.startsWith(prefix)).length,
        `no key remains for the runtime-built family ${prefix}*`,
      ).toBeGreaterThan(0);
    }
  });

  it("translates keyed parameters without translating user values", () => {
    expect(
      translate("de", "config.source.not_found", {
        path: "/Volumes/Family screenshots",
      }),
    ).toContain("/Volumes/Family screenshots");
    expect(translate("de", "rules.kind.route")).toBe("Routenregel");
    expect(translate("en", "unknown.key", {}, "Technical fallback")).toBe("Technical fallback");
  });

  it("formats user-facing numbers and durations for German", () => {
    expect(formatCount(1234, "de")).toMatch(/1[.\s]234/);
    expect(formatBytes(1536, { locale: "de", decimals: 1 })).toBe("1,5 KB");
    expect(formatDuration(90, { locale: "de", style: "verbose" })).toBe("2 Minuten");
  });

  it("loads the persisted locale and changes rendered resources immediately", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (key === "mediasort_language" ? "de" : null),
      },
    });
    try {
      expect(storedLocale()).toBe("de");
      expect(translate("en", "progress.analyzingFiles")).toBe("Analyzing files…");
      expect(translate("de", "progress.analyzingFiles")).toBe("Dateien werden analysiert…");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("localizes progress, errors, and accessible names", () => {
    expect(translate("de", "preview.failed")).toBe("Vorschau fehlgeschlagen.");
    expect(translate("de", "review.compare.title")).toBe("Kopien vergleichen");
    expect(
      translate("de", "progress.files", {
        current: "1.234",
        total: "5.678",
        percentage: "21",
      }),
    ).toBe("1.234 / 5.678 Dateien · 21 %");
  });

  it("localizes singular counts and metadata-source labels", () => {
    expect(translate("de", "sources.facts.indexed.one")).toBe("1 Datei indiziert");
    expect(translate("en", "config.reset.confirm.one")).toBe("Reset 1 setting");
    expect(translate("de", "review.setSelection.count.one")).toBe("1 Satz ausgewählt");
    expect(formatMetadataSource("video_metadata", (key) => translate("de", key))).toBe(
      "Videometadaten",
    );
    expect(formatMetadataSource("filesystem", (key) => translate("de", key))).toBe("Dateisystem");
    expect(formatMetadataSource("none", (key) => translate("de", key))).toBe("Unbekannt");
    expect(formatMetadataSource("custom_source", (key) => translate("de", key))).toBe(
      "custom source",
    );
  });

  it("keeps every newly reachable staged panel free of raw English UI text", () => {
    const panels = {
      "SourcesScreen.tsx": sourcesScreenSource,
      "ConfigureScreen.tsx": configureScreenSource,
      "ReviewScreen.tsx": reviewScreenSource,
      "ExecuteScreen.tsx": executeScreenSource,
      "CompareModal.tsx": compareModalSource,
      "DestinationTree.tsx": destinationTreeSource,
      "RecipeGrid.tsx": recipeGridSource,
      "RecipeScreen.tsx": recipeScreenSource,
      "RunLog.tsx": runLogSource,
      "TitleBar.tsx": titleBarSource,
      "StageStepper.tsx": stageStepperSource,
      "OperationCenter.tsx": operationCenterSource,
    };
    for (const [panel, source] of Object.entries(panels)) {
      const sourceFile = ts.createSourceFile(
        panel,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const rawText: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          const keyboardShortcut =
            /^\(?Alt\+[A-Za-z0-9↑↓…]+(?:\s*\/\s*Alt\+[A-Za-z0-9↑↓…]+)?\)?$/.test(text);
          // Three things are the same in every locale and must not be routed
          // through the catalogue: the product's name, the "v" that prefixes a
          // version number, and a language's own code in its own language —
          // translating "EN" into German would make the picker unusable to the
          // very person who needs it.
          const localeInvariant = /^(MediaSorter|v|EN|DE)$/.test(text);
          if (/[A-Za-z]/.test(text) && !keyboardShortcut && !localeInvariant) {
            rawText.push(text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      expect(rawText, panel).toEqual([]);
      expect(source, panel).not.toMatch(/t\(\s*["'][^"']+["']\s*,\s*undefined\s*,\s*["'][A-Za-z]/);
    }
  });
});
