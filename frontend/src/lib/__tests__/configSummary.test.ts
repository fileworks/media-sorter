import { describe, expect, it } from "vitest";

import { SECTION_DEFAULTS } from "@/components/config/constants";
import {
  INVENTED_SAMPLES,
  activeJunkFilterCount,
  activeScanFilterCount,
  exampleFilename,
  folderPreviewTree,
  folderStructureSummary,
  possibleReviewFolders,
  predictedExtension,
  sampleFiles,
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

describe("folder preview tree", () => {
  const invented = INVENTED_SAMPLES;

  it("nests the date folders and puts the sample files at the leaf", () => {
    const [dates] = folderPreviewTree(
      { ...BASE, sort_criteria: ["year", "month"] },
      t,
      "en",
      invented,
    );

    expect(dates).toMatchObject({ name: "2025", kind: "folder" });
    const month = dates.children?.[0];
    expect(month).toMatchObject({ name: "07 — July", kind: "folder" });
    expect(month?.children?.map((node) => node.name)).toEqual([
      "IMG_4382.JPG",
      "VID_0042.mp4",
      "_copies",
    ]);
  });

  it("draws the review folders beside the date hierarchy, never inside it", () => {
    const nodes = folderPreviewTree({ ...BASE, sort_criteria: ["year"] }, t, "en", invented);
    const review = nodes.filter((node) => node.kind === "review").map((node) => node.name);

    expect(nodes[0]).toMatchObject({ name: "2025", kind: "folder" });
    expect(review).toContain("_undated");
    expect(review).toContain("_corrupted");
    expect(review).not.toContain("_copies");
  });

  it("offers only the review folders the settings can actually produce", () => {
    expect(possibleReviewFolders(BASE)).not.toContain("_copies");
    expect(possibleReviewFolders({ ...BASE, junk_filter_enabled: true })).toContain("_junk");
    // A file can always defeat a read, whatever the settings say.
    expect(possibleReviewFolders(BASE)).toContain("_corrupted");
  });

  it("shows only the review folders in deduplicate-only, because nothing is placed", () => {
    const nodes = folderPreviewTree({ ...BASE, run_mode: "deduplicate_only" }, t, "en", invented);

    expect(nodes.every((node) => node.kind === "review")).toBe(true);
    expect(nodes.map((node) => node.name)).not.toContain("_undated");
  });

  it("puts the files at the root when nothing is filed by date", () => {
    const nodes = folderPreviewTree({ ...BASE, sort: false }, t, "en", invented);

    expect(nodes.filter((node) => node.kind === "file").map((node) => node.name)).toEqual([
      "IMG_4382.JPG",
      "VID_0042.mp4",
    ]);
  });
});

describe("example filenames", () => {
  it("applies the rename pattern", () => {
    expect(
      exampleFilename(
        { ...BASE, rename: true, rename_pattern: "YYYY-MM-DD_NAME" },
        INVENTED_SAMPLES[0],
      ),
    ).toBe("2025-07-14_IMG_4382.JPG");
  });

  it("keeps an extension exactly as it is when nothing converts it", () => {
    expect(predictedExtension(BASE, INVENTED_SAMPLES[0])).toBe(".JPG");
  });

  it("rewrites the extension only where conversion actually changes the format", () => {
    const toJpeg = { ...BASE, convert_images: true, image_format: "jpeg" } as Config;
    // Already JPEG — the backend skips the re-encode, so the suffix survives.
    expect(predictedExtension(toJpeg, INVENTED_SAMPLES[0])).toBe(".JPG");
    expect(predictedExtension(toJpeg, { ...INVENTED_SAMPLES[0], extension: ".HEIC" })).toBe(".jpg");
  });
});

describe("samples from a dry run", () => {
  it("prefers one image and one video, so the TYPE token has something to show", () => {
    const picked = sampleFiles([
      { source: "/in/a/DSC_0001.NEF", extracted_date: "2024-03-15" },
      { source: "/in/a/DSC_0002.NEF", extracted_date: "2024-03-15" },
      { source: "/in/a/clip.mov", extracted_date: null },
    ]);

    expect(picked.map((file) => `${file.stem}${file.extension}`)).toEqual([
      "DSC_0001.NEF",
      "clip.mov",
    ]);
    expect(picked[0]).toMatchObject({ kind: "IMG", invented: false });
    expect(picked[1]).toMatchObject({ kind: "VID", date: null });
  });

  it("returns nothing when the run had nothing, so the caller can fall back", () => {
    expect(sampleFiles([])).toEqual([]);
  });
});
