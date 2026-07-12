import { describe, it, expect } from "vitest";
import {
  changedKeys,
  configFieldLabel,
  diffConfig,
  formatConfigValue,
  humanizeConfigKey,
} from "@/lib/configDiff";
import type { Config } from "@/types/api";

// Only the keys under test need to exist; cast partials to Config since the diff
// helpers read by the keys present in `defaults`.
const cfg = (o: Partial<Config>): Config => o as Config;

describe("formatConfigValue", () => {
  it("renders booleans as On/Off", () => {
    expect(formatConfigValue(true)).toBe("On");
    expect(formatConfigValue(false)).toBe("Off");
  });

  it("renders empty-ish values as Not set", () => {
    expect(formatConfigValue(null)).toBe("Not set");
    expect(formatConfigValue(undefined)).toBe("Not set");
    expect(formatConfigValue("")).toBe("Not set");
  });

  it("summarises arrays", () => {
    expect(formatConfigValue([])).toBe("None");
    expect(formatConfigValue(["year", "month"])).toBe("year, month");
    expect(formatConfigValue([1, 2, 3, 4, 5])).toBe("5 items");
  });

  it("stringifies scalars", () => {
    expect(formatConfigValue(95)).toBe("95");
    expect(formatConfigValue("mp4")).toBe("mp4");
  });
});

describe("humanizeConfigKey / configFieldLabel", () => {
  it("humanizes unknown keys with acronym handling", () => {
    expect(humanizeConfigKey("repair_enabled")).toBe("Repair Enabled");
    expect(humanizeConfigKey("ai_allow_gpu")).toBe("AI Allow GPU");
  });

  it("prefers a friendly override when present", () => {
    expect(configFieldLabel("duplicate_perceptual_threshold")).toBe("Similarity threshold");
    expect(configFieldLabel("ai_model_tier")).toBe("AI model tier");
  });
});

describe("changedKeys", () => {
  it("returns only the keys that differ from defaults", () => {
    const defaults = cfg({ sort: true, image_format: "jpeg", sort_criteria: ["year"] });
    const config = cfg({
      sort: true,
      image_format: "png",
      sort_criteria: ["year", "month"],
    });
    expect(changedKeys(config, defaults)).toEqual(new Set(["image_format", "sort_criteria"]));
  });

  it("treats arrays order-sensitively", () => {
    const defaults = cfg({ sort_criteria: ["year", "month"] });
    expect(
      changedKeys(cfg({ sort_criteria: ["month", "year"] }), defaults).has("sort_criteria"),
    ).toBe(true);
    expect(changedKeys(cfg({ sort_criteria: ["year", "month"] }), defaults).size).toBe(0);
  });
});

describe("diffConfig", () => {
  it("produces sorted, display-ready entries", () => {
    const defaults = cfg({ image_format: "jpeg", repair_enabled: true });
    const config = cfg({ image_format: "png", repair_enabled: false });
    const entries = diffConfig(config, defaults);
    expect(entries.map((e) => e.key)).toEqual(["image_format", "repair_enabled"]);
    expect(entries[0]).toMatchObject({
      label: "Image Format",
      current: "png",
      default: "jpeg",
    });
    expect(entries[1]).toMatchObject({ current: "Off", default: "On" });
  });

  it("returns nothing when config matches defaults", () => {
    const defaults = cfg({ sort: true, rename: false });
    expect(diffConfig(cfg({ sort: true, rename: false }), defaults)).toEqual([]);
  });
});
