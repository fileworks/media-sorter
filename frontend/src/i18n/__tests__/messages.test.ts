import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import operationCenterSource from "@/components/OperationCenter.tsx?raw";
import sourcesScreenSource from "@/components/screens/SourcesScreen.tsx?raw";
import configureScreenSource from "@/components/screens/ConfigureScreen.tsx?raw";
import reviewScreenSource from "@/components/screens/ReviewScreen.tsx?raw";
import executeScreenSource from "@/components/screens/ExecuteScreen.tsx?raw";
import duplicatesTabSource from "@/components/screens/review/DuplicatesTab.tsx?raw";
import warningsTabSource from "@/components/screens/review/WarningsTab.tsx?raw";
import junkTabSource from "@/components/screens/review/JunkTab.tsx?raw";
import compareModalSource from "@/components/screens/review/CompareModal.tsx?raw";
import destinationTreeSource from "@/components/screens/review/DestinationTree.tsx?raw";
import planSummarySource from "@/components/screens/review/PlanSummary.tsx?raw";
import recipeGridSource from "@/components/screens/RecipeGrid.tsx?raw";
import runLogSource from "@/components/screens/RunLog.tsx?raw";
import titleBarSource from "@/components/shell/TitleBar.tsx?raw";
import stageStepperSource from "@/components/shell/StageStepper.tsx?raw";
import { de, en } from "@/i18n/messages";
import { storedLocale, translate } from "@/i18n/I18nContext";
import { formatBytes, formatCount, formatDuration } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";

/**
 * Every source file, so key usage can be checked against the catalogue rather
 * than against a hand-maintained list that goes stale the moment a file moves.
 */
const RAW_SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Surfaces `remove-unreachable-frontend-surfaces` deleted outright. */
const REMOVED_NAMESPACES = [
  "quarantine.",
  "audit.",
  "reconcile.",
  "bursts.",
  "catalog.",
  "validation.",
];

const PRODUCT_SOURCES = Object.entries(RAW_SOURCES).filter(
  ([path]) => !path.includes("__tests__") && !path.includes("i18n/messages.ts"),
);

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
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/\btranslate\(\s*[^,()]+,\s*"([^"]+)"/g)) keys.add(match[1]);
  }
  return keys;
}

/** Prefixes of keys assembled at runtime, e.g. `` `config.keeper.${id}` `` . */
function templateKeyPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  for (const [, source] of PRODUCT_SOURCES) {
    for (const match of source.matchAll(/`([a-zA-Z][a-zA-Z0-9_.]*\.)\$\{/g)) prefixes.add(match[1]);
  }
  return prefixes;
}

describe("English/German resources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "mediasort_language" ? "de" : null),
    });

    expect(storedLocale()).toBe("de");
    expect(translate("en", "progress.analyzingFiles")).toBe("Analyzing files…");
    expect(translate("de", "progress.analyzingFiles")).toBe("Dateien werden analysiert…");
  });

  it("localizes progress, errors, and accessible names", () => {
    expect(translate("de", "preview.failed")).toBe("Vorschau fehlgeschlagen.");
    expect(translate("de", "operation.cancel")).toBe("Aktuellen Vorgang abbrechen");
    expect(
      translate("de", "progress.previewFiles", {
        current: "1.234",
        total: "5.678",
      }),
    ).toBe("Vorschau: 1.234 / 5.678 Dateien");
  });

  it("localizes singular counts and metadata-source labels", () => {
    expect(translate("de", "analysis.filesFound.one", { count: 1 })).toBe("1 Datei gefunden");
    expect(translate("en", "report.organized.one", { count: 1 })).toBe("1 file organized");
    expect(
      translate("de", "history.operationSummary.one", {
        date: "25. Juli 2026",
        total: 1,
        sorted: 1,
        percentage: "100,0",
        duration: "0s",
      }),
    ).toContain("1 Datei");
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
      "DuplicatesTab.tsx": duplicatesTabSource,
      "WarningsTab.tsx": warningsTabSource,
      "JunkTab.tsx": junkTabSource,
      "CompareModal.tsx": compareModalSource,
      "DestinationTree.tsx": destinationTreeSource,
      "PlanSummary.tsx": planSummarySource,
      "RecipeGrid.tsx": recipeGridSource,
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
