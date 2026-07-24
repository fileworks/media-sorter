import { describe, it, expect } from "vitest";
import { buildFlatRows, MONTH_NAMES, type FlatRow } from "@/lib/previewRows";
import type { PreviewItem } from "@/types/api";

/** Minimal PreviewItem factory — only the fields buildFlatRows reads matter. */
const mk = (o: Partial<PreviewItem>): PreviewItem => ({
  source: "/src/a.jpg",
  destination: null,
  extracted_date: null,
  metadata_source: "none",
  tags: [],
  status: "sort",
  ...o,
});

const kinds = (rows: FlatRow[]) => rows.map((r) => r.kind);
const ofKind = <K extends FlatRow["kind"]>(rows: FlatRow[], kind: K) =>
  rows.filter((r): r is Extract<FlatRow, { kind: K }> => r.kind === kind);

describe("buildFlatRows — date grouping", () => {
  it("groups sort files by year, descending, and is collapsed by default", () => {
    const items = [
      mk({ source: "/a", extracted_date: "2023-05-01" }),
      mk({ source: "/b", extracted_date: "2023-08-01" }),
      mk({ source: "/c", extracted_date: "2022-01-01" }),
    ];
    const rows = buildFlatRows(items, new Set(), ["year"]);
    const years = ofKind(rows, "year");
    expect(years.map((y) => y.year)).toEqual(["2023", "2022"]);
    expect(years[0].count).toBe(2);
    expect(years[1].count).toBe(1);
    // Nothing expanded → no file rows.
    expect(kinds(rows)).not.toContain("file");
  });

  it("reveals file rows when the year is expanded (year-only depth = 1)", () => {
    const items = [
      mk({ source: "/a", extracted_date: "2023-05-01" }),
      mk({ source: "/b", extracted_date: "2023-08-01" }),
    ];
    const rows = buildFlatRows(items, new Set(["y-2023"]), ["year"]);
    const files = ofKind(rows, "file");
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.depth === 1)).toBe(true);
  });

  it("builds year → month → day hierarchy with a real month name", () => {
    const items = [mk({ source: "/a", extracted_date: "2023-05-14" })];
    const expanded = new Set(["y-2023", "m-2023-05", "d-2023-05-14"]);
    const rows = buildFlatRows(items, expanded, ["year", "month", "day"]);
    expect(kinds(rows)).toEqual(["year", "month", "day", "file"]);
    const month = ofKind(rows, "month")[0];
    expect(month.monthName).toBe(MONTH_NAMES[4]); // May
    expect(ofKind(rows, "file")[0].depth).toBe(3);
  });

  it("treats items with no extracted date as year 'Unknown'", () => {
    const rows = buildFlatRows([mk({ source: "/a", extracted_date: null })], new Set(), ["year"]);
    expect(ofKind(rows, "year")[0].year).toBe("Unknown");
  });
});

describe("buildFlatRows — Smart Categorization", () => {
  it("buckets files under category headers with _uncategorized last", () => {
    const items = [
      mk({ source: "/a", extracted_date: "2023-01-01", category: "beach" }),
      mk({ source: "/b", extracted_date: "2023-01-01", category: null }),
      mk({ source: "/c", extracted_date: "2023-01-01", category: "animals" }),
    ];
    const rows = buildFlatRows(items, new Set(["y-2023"]), ["year"], true);
    const headers = ofKind(rows, "cat-header");
    // Named categories alphabetical, _uncategorized forced to the end.
    expect(headers.map((h) => h.name)).toEqual(["animals", "beach", "_uncategorized"]);
    expect(headers[2].isUncategorized).toBe(true);
    // Files hidden until the category is expanded.
    expect(kinds(rows)).not.toContain("cat-file");
  });

  it("reveals category files when a category key is expanded", () => {
    const items = [mk({ source: "/a", extracted_date: "2023-01-01", category: "beach" })];
    const rows = buildFlatRows(items, new Set(["y-2023", "y-2023-cat-beach"]), ["year"], true);
    expect(ofKind(rows, "cat-file")).toHaveLength(1);
  });
});

describe("buildFlatRows — duplicates", () => {
  it("nests dated duplicates under their date bucket", () => {
    const items = [
      mk({ source: "/a", extracted_date: "2023-01-01", status: "sort" }),
      mk({ source: "/dup", extracted_date: "2023-01-01", status: "duplicate" }),
    ];
    const rows = buildFlatRows(items, new Set(["y-2023", "y-2023-dup"]), ["year"]);
    expect(ofKind(rows, "date-dup-header")).toHaveLength(1);
    expect(ofKind(rows, "date-dup-file")).toHaveLength(1);
    // The year count includes both the sort file and the duplicate.
    expect(ofKind(rows, "year")[0].count).toBe(2);
  });

  it("routes undated move-duplicates into the _duplicates/ folder section", () => {
    const rows = buildFlatRows(
      [mk({ source: "/dup", extracted_date: null, status: "duplicate" })],
      new Set(),
      ["year"],
    );
    const folders = ofKind(rows, "folder-header");
    expect(folders.some((f) => f.folderKey === "duplicates")).toBe(true);
  });
});

describe("buildFlatRows — special-status folders", () => {
  it("emits folder sections for unknown/future/failed sorted by label", () => {
    const items = [
      mk({ source: "/u", status: "unknown_date" }),
      mk({ source: "/f", status: "future_date" }),
      mk({ source: "/x", status: "failed" }),
    ];
    const rows = buildFlatRows(items, new Set(), ["year"]);
    const labels = ofKind(rows, "folder-header").map((f) => f.label);
    expect(labels).toEqual(["_failed/", "_future_dates/", "_unknown_dates/"]);
  });

  it("returns an empty list for no items", () => {
    expect(buildFlatRows([], new Set())).toEqual([]);
  });
});

describe("buildFlatRows — P0 engine outcome buckets", () => {
  it("groups junk items under a _junk/ folder section", () => {
    const items = [
      mk({ source: "/a", extracted_date: "2023-05-01" }),
      mk({ source: "/thumb", status: "junk", quarantine_reason: "below floor" }),
    ];
    const rows = buildFlatRows(items, new Set(["folder-junk"]), ["year"]);
    const folders = ofKind(rows, "folder-header");
    const junk = folders.find((f) => f.folderKey === "junk");
    expect(junk?.label).toBe("_junk/");
    expect(junk?.count).toBe(1);
    expect(ofKind(rows, "folder-file")).toHaveLength(1);
  });

  it("groups destination-dedup outcomes in their own folder sections", () => {
    const items = [
      mk({ source: "/dup1", status: "already_in_destination", extracted_date: "2023-01-01" }),
    ];
    const rows = buildFlatRows(items, new Set(), ["year"]);
    const folders = ofKind(rows, "folder-header");
    expect(folders.map((f) => f.folderKey)).toEqual(
      expect.arrayContaining(["already_in_destination"]),
    );
    // Destination-scope items never join the dated in-run duplicate buckets.
    expect(kinds(rows)).not.toContain("date-dup-header");
  });

  it("keeps unknown video perceptual checks out of promised date destinations", () => {
    const rows = buildFlatRows(
      [
        mk({
          source: "/clip.mp4",
          status: "duplicate_unknown",
          extracted_date: "2024-01-02",
          duplicate_evaluation: "unknown",
          duplicate_unknown_reason: "video_perceptual_not_computed",
        }),
      ],
      new Set(["folder-duplicate_unknown"]),
      ["year"],
    );
    expect(ofKind(rows, "year")).toHaveLength(0);
    expect(ofKind(rows, "folder-header")[0].folderKey).toBe("duplicate_unknown");
    expect(ofKind(rows, "folder-file")).toHaveLength(1);
  });
});
