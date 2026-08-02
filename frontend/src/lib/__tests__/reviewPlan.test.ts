import { describe, expect, it } from "vitest";

import {
  destinationRootName,
  destinationTree,
  nameCollisions,
  planTotals,
  planWarnings,
  tabCounts,
  warningTotal,
} from "@/lib/reviewPlan";
import type { Config, PreviewItem, PreviewResult } from "@/types/api";

function item(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    source: "/input/IMG_0001.jpg",
    destination: "2025/07/IMG_0001.jpg",
    extracted_date: "2025-07-14",
    metadata_source: "exif",
    tags: [],
    status: "sort",
    ...overrides,
  };
}

function result(
  items: PreviewItem[],
  stats: Partial<PreviewResult["stats"]> = {},
  impact: Partial<PreviewResult["impact"]> = {},
): PreviewResult {
  return {
    config_fingerprint: "fp",
    plan_id: "plan",
    items,
    partial: false,
    issues: [],
    impact: {
      actionable_groups: 0,
      copy_count: 0,
      move_count: 0,
      quarantine_count: 0,
      quarantine_bytes: 0,
      skip_count: 0,
      source_mutations: 0,
      required_bytes: 0,
      conversion_without_originals: 0,
      companions_left_in_place: 0,
      embedded_tag_count: 0,
      unresolved_count: 0,
      ...impact,
    },
    stats: {
      total: items.length,
      will_sort: items.filter((entry) => entry.status === "sort").length,
      will_fail: 0,
      will_quarantine_unknown: 0,
      will_quarantine_future: 0,
      will_skip_duplicate: 0,
      will_quarantine_junk: 0,
      will_skip_already_in_destination: 0,
      uncategorized: 0,
      ...stats,
    },
  };
}

describe("plan totals", () => {
  it("splits the scan into bands that describe the same population", () => {
    const totals = planTotals(
      result([], { total: 1000, will_sort: 900, will_skip_duplicate: 80, will_quarantine_junk: 20 }, {
        unresolved_count: 30,
      }),
      4,
    );

    expect(totals.scanned).toBe(1000);
    expect(totals.ready).toBe(900);
    expect(totals.duplicates).toBe(80);
    expect(totals.junk).toBe(20);
    expect(totals.warnings).toBe(4);
    expect(Math.round(totals.share.ready + totals.share.duplicates + totals.share.junk)).toBe(100);
  });

  it("splits duplicates into decided and still-open", () => {
    const totals = planTotals(
      result([], { total: 100, will_skip_duplicate: 40 }, { unresolved_count: 15 }),
      0,
    );

    expect(totals.duplicatesResolved).toBe(25);
    expect(totals.duplicatesUnresolved).toBe(15);
  });

  it("reports zero shares rather than dividing by an empty scan", () => {
    const totals = planTotals(result([], { total: 0, will_sort: 0 }), 0);

    expect(totals.share).toEqual({ ready: 0, duplicates: 0, junk: 0 });
  });
});

describe("name collisions", () => {
  it("finds two files that would land on the same name", () => {
    const collisions = nameCollisions([
      item({ source: "/a/one.jpg", destination: "2025/07/shot.jpg" }),
      item({ source: "/b/two.jpg", destination: "2025/07/shot.jpg" }),
      item({ source: "/c/three.jpg", destination: "2025/07/other.jpg" }),
    ]);

    expect([...collisions.keys()]).toEqual(["2025/07/shot.jpg"]);
    expect(collisions.get("2025/07/shot.jpg")).toHaveLength(2);
  });

  it("ignores files that are not being written", () => {
    const collisions = nameCollisions([
      item({ source: "/a/one.jpg", destination: "2025/07/shot.jpg", status: "duplicate" }),
      item({ source: "/b/two.jpg", destination: "2025/07/shot.jpg", status: "junk" }),
      item({ source: "/c/three.jpg", destination: null }),
    ]);

    expect(collisions.size).toBe(0);
  });
});

describe("plan warnings", () => {
  it("lists only findings that actually occurred, worst first", () => {
    const warnings = planWarnings(
      result([
        item({ source: "/a.jpg", status: "failed" }),
        item({ source: "/b.jpg", status: "unknown_date" }),
        item({ source: "/c.jpg", status: "unknown_date" }),
        item({ source: "/d.jpg", destination: "2025/07/x.jpg" }),
        item({ source: "/e.jpg", destination: "2025/07/x.jpg" }),
      ]),
    );

    expect(warnings[0].id).toBe("unreadable");
    expect(warnings[0].severity).toBe("error");
    expect(warnings.map((warning) => warning.id)).toContain("no_date");
    expect(warnings.map((warning) => warning.id)).toContain("name_collision");
    // Two files want one name; one of them is the casualty.
    expect(warnings.find((warning) => warning.id === "name_collision")?.count).toBe(1);
    expect(warnings.every((warning) => warning.count > 0)).toBe(true);
  });

  it("separates a missing date from a date borrowed off the filesystem", () => {
    const warnings = planWarnings(
      result([
        item({ source: "/a.jpg", metadata_source: "filesystem" }),
        item({ source: "/b.jpg", status: "unknown_date" }),
      ]),
    );

    expect(warnings.find((warning) => warning.id === "fallback_date")?.count).toBe(1);
    expect(warnings.find((warning) => warning.id === "no_date")?.count).toBe(1);
  });

  it("says nothing about a clean plan", () => {
    const warnings = planWarnings(result([item()]));

    expect(warnings).toEqual([]);
    expect(warningTotal(warnings)).toBe(0);
  });
});

describe("destination tree", () => {
  const items = [
    item({ source: "/a.jpg", destination: "2025/07 — July/a.jpg" }),
    item({ source: "/b.jpg", destination: "2025/07 — July/b.jpg" }),
    item({ source: "/c.jpg", destination: "2025/08 — August/c.jpg" }),
    item({ source: "/d.jpg", destination: "_duplicates/d.jpg" }),
  ];

  it("counts every file at each level above it", () => {
    const tree = destinationTree(items, "Sorted");

    expect(tree.name).toBe("Sorted");
    expect(tree.count).toBe(4);
    const year = tree.children.find((node) => node.name === "2025");
    expect(year?.count).toBe(3);
    expect(year?.children.find((node) => node.name === "07 — July")?.count).toBe(2);
  });

  it("sorts review folders after real ones", () => {
    const tree = destinationTree(items, "Sorted");

    expect(tree.children.map((node) => node.name)).toEqual(["2025", "_duplicates"]);
    expect(tree.children[tree.children.length - 1].isReview).toBe(true);
  });

  it("badges only folders the destination does not already have", () => {
    const tree = destinationTree(items, "Sorted", {
      existingFolders: new Set(["2025", "2025/07 — July"]),
    });
    const year = tree.children.find((node) => node.name === "2025");

    expect(year?.isNew).toBe(false);
    expect(year?.children.find((node) => node.name === "07 — July")?.isNew).toBe(false);
    expect(year?.children.find((node) => node.name === "08 — August")?.isNew).toBe(true);
  });

  it("ignores items with nowhere to go", () => {
    expect(destinationTree([item({ destination: null })], "Sorted").count).toBe(0);
  });

  it("draws the library, not the machine's directory layout", () => {
    // The plan reports absolute paths; the tree must show what lands *inside*
    // the destination, not the folders leading up to it.
    const tree = destinationTree(
      [
        item({ source: "/a.jpg", destination: "/Volumes/Media/Sorted/2025/07/a.jpg" }),
        item({ source: "/b.jpg", destination: "/Volumes/Media/Sorted/2025/08/b.jpg" }),
      ],
      "Sorted",
      { rootPath: "/Volumes/Media/Sorted" },
    );

    expect(tree.children.map((node) => node.name)).toEqual(["2025"]);
    expect(tree.children[0].children.map((node) => node.name)).toEqual(["07", "08"]);
  });

  it("tolerates a trailing separator and Windows separators on the root", () => {
    const tree = destinationTree(
      [item({ source: "/a.jpg", destination: "C:\\Media\\Sorted\\2025\\a.jpg" })],
      "Sorted",
      { rootPath: "C:\\Media\\Sorted\\" },
    );

    expect(tree.children.map((node) => node.name)).toEqual(["2025"]);
  });

  it("leaves a destination outside the root whole rather than mangling it", () => {
    const tree = destinationTree(
      [item({ source: "/a.jpg", destination: "/elsewhere/2025/a.jpg" })],
      "Sorted",
      { rootPath: "/Volumes/Media/Sorted" },
    );

    expect(tree.children.map((node) => node.name)).toEqual(["elsewhere"]);
  });

  it("names the root after the configured destination folder", () => {
    expect(destinationRootName({ target_directory: "/Users/x/Pictures/Sorted" } as Config)).toBe(
      "Sorted",
    );
    expect(destinationRootName(undefined)).toBe("Destination");
  });
});

describe("tab counts", () => {
  it("counts each tab from the plan rather than from the rendered list", () => {
    const plan = result([item({ source: "/a.jpg", status: "failed" })], {
      total: 10,
      will_sort: 7,
      will_skip_duplicate: 2,
      will_quarantine_junk: 1,
    });

    expect(tabCounts(plan, planWarnings(plan))).toEqual({
      duplicates: 2,
      junk: 1,
      changes: 7,
      warnings: 1,
    });
  });
});
