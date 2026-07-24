import { afterEach, describe, expect, it, vi } from "vitest";
import { de, en } from "@/i18n/messages";
import { storedLocale, translate } from "@/i18n/I18nContext";
import { formatBytes, formatCount, formatDuration } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";

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
});
