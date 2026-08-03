import { describe, expect, it } from "vitest";

import { SECTION_DEFAULTS } from "@/components/config/constants";
import {
  activeJunkFilterCount,
  activeScanFilterCount,
  examplePath,
  folderStructureSummary,
  summariesFor,
} from "@/lib/configSummary";
import { en } from "@/i18n/messages";
import type { Config } from "@/types/api";

/** The real English catalogue, so a missing key shows up as the raw key. */
const t = (key: string, params: Record<string, string | number> = {}): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );

const BASE = {
  ...Object.assign({}, ...Object.values(SECTION_DEFAULTS)),
  copy_instead_of_move: true,
  duplicate_keeper_policy: "newest",
  image_quality: 90,
  video_quality: "medium",
  junk_filter_enabled: false,
  junk_min_file_size_kb: 8,
  junk_min_image_dimension: 200,
  junk_filename_patterns: [],
  rules_enabled: true,
  rule_set: { version: 1, tag_rules: [], route_rules: [] },
  ai_tagging_enabled: false,
  ai_tagging_provider: "local",
  exclude_patterns: [],
  min_file_size_kb: null,
  max_file_size_mb: null,
  recursive_scan: true,
} as Config;

describe("rail summaries", () => {
  it("gives every rail entry a line, and never a bare message key", () => {
    const summaries = summariesFor(BASE, t);
    const entries = Object.entries(summaries);

    expect(entries.length).toBeGreaterThan(0);
    for (const [id, line] of entries) {
      expect(line, id).toBeTruthy();
      expect(line, id).not.toMatch(/^config\./);
    }
  });

  it("states the transfer posture and that it is verified", () => {
    expect(summariesFor(BASE, t)["setting-transfer"]).toBe("Copy · verified");
    expect(summariesFor({ ...BASE, copy_instead_of_move: false }, t)["setting-transfer"]).toBe(
      "Move · verified",
    );
  });

  it("names the keep rule, and says Off when duplicates are not looked for", () => {
    expect(summariesFor(BASE, t)["setting-duplicates"]).toBe("Keep newest");
    expect(
      summariesFor({ ...BASE, duplicate_keeper_policy: "smallest" }, t)["setting-duplicates"],
    ).toBe("Keep smallest");
    expect(summariesFor({ ...BASE, remove_duplicates: false }, t)["setting-duplicates"]).toBe(
      "Off",
    );
  });

  it("reports conversion by target format, not by a boolean", () => {
    expect(summariesFor(BASE, t)["setting-conversion"]).toBe("Keep formats");
    expect(
      summariesFor({ ...BASE, convert_images: true, image_format: "jpeg" }, t)[
        "setting-conversion"
      ],
    ).toBe("→ JPEG");
  });

  it("distinguishes offline tagging from a cloud provider", () => {
    expect(summariesFor({ ...BASE, ai_tagging_enabled: true }, t)["setting-ai"]).toBe(
      "On · offline",
    );
    expect(
      summariesFor({ ...BASE, ai_tagging_enabled: true, ai_tagging_provider: "imagga" }, t)[
        "setting-ai"
      ],
    ).toBe("On · cloud");
  });
});

describe("folder structure summary", () => {
  it("reads back the criteria in order", () => {
    expect(folderStructureSummary({ ...BASE, sort_criteria: ["year", "month"] }, t)).toBe(
      "Year / Month",
    );
  });

  it("appends the extras that add another level", () => {
    expect(
      folderStructureSummary(
        { ...BASE, sort_criteria: ["year"], camera_subfolder_enabled: true },
        t,
      ),
    ).toBe("Year · camera");
  });

  it("says so when nothing is being filed by date at all", () => {
    expect(folderStructureSummary({ ...BASE, sort: false }, t)).toBe("No date folders");
  });
});

describe("filter counts", () => {
  it("counts only junk rules that would actually catch something", () => {
    expect(activeJunkFilterCount(BASE)).toBe(0);
    expect(
      activeJunkFilterCount({
        ...BASE,
        junk_filter_enabled: true,
        junk_min_file_size_kb: 50,
        junk_min_image_dimension: 0,
        junk_filename_patterns: ["screenshot*"],
      }),
    ).toBe(2);
  });

  it("counts a switched-off recursion as a narrowing of the scan", () => {
    expect(activeScanFilterCount(BASE)).toBe(0);
    expect(activeScanFilterCount({ ...BASE, recursive_scan: false })).toBe(1);
    expect(
      activeScanFilterCount({ ...BASE, min_file_size_kb: 10, exclude_patterns: [".DS_Store"] }),
    ).toBe(2);
  });
});

describe("example path", () => {
  it("shows the concrete folder a photo would land in", () => {
    expect(examplePath({ ...BASE, sort_criteria: ["year", "month"] }, t, "en")).toBe(
      "Sorted / 2025 / 07 — July / IMG_4382.jpg",
    );
  });

  it("drops the date folders when sorting is off", () => {
    expect(examplePath({ ...BASE, sort: false }, t, "en")).toBe("Sorted / IMG_4382.jpg");
  });

  it("applies the rename pattern to the example filename", () => {
    const path = examplePath(
      { ...BASE, sort_criteria: ["year"], rename: true, rename_pattern: "YYYY-MM-DD_NAME" },
      t,
      "en",
    );

    expect(path).toBe("Sorted / 2025 / 2025-07-14_IMG_4382.jpg");
  });
});
