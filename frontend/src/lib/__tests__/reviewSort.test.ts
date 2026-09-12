/**
 * The one order the Review screen sorts by.
 *
 * Three things have to hold or a sorted list misleads: "by size" and "by date"
 * mean largest and newest *first*, a file with no date sorts to the end rather
 * than the top, and a duplicate set is ranked by the copy that actually decides
 * its weight. All three are asserted against the real entry shapes, because the
 * bug this guards is a set and a file being ranked on different fields.
 */

import { describe, expect, it } from "vitest";

import type { BrowseEntry, SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";
import {
  compareBySort,
  isReviewSort,
  rowSortModel,
  setSortModel,
  sortEntries,
  sortRows,
  type ReviewSort,
} from "@/lib/reviewSort";

function row(name: string, sizeBytes: number, date: string | null): ReviewRow {
  return {
    source: `/src/${name}`,
    name,
    folder: "camera",
    destination: `/dst/${name}`,
    wouldBeDestination: null,
    status: "organize",
    flags: [],
    sizeBytes,
    date,
    dateSource: "exif",
    category: null,
    tags: [],
    unitId: null,
    unitPrimary: true,
    companionCount: 0,
    provenance: null,
    stack: null,
    reason: { key: "review.reason.duplicatePlain", params: {} },
    undated: date === null,
    suspiciousDate: false,
    futureDate: false,
    setAsideCategory: null,
  };
}

function fileEntry(value: ReviewRow): BrowseEntry {
  return { kind: "file", key: `file:${value.source}`, row: value, folder: "2024/07" };
}

function setEntry(id: string, rows: ReviewRow[]): SetEntry {
  return {
    kind: "set",
    key: `set:${id}`,
    id,
    setKind: "exact",
    origin: "catalog",
    rows,
    keeper: rows[0] ?? null,
    hasBaseline: false,
    decisionState: "undecided",
    decisionKind: null,
    proposedKeeper: null,
    proposalPolicy: null,
    similarity: 100,
    folder: "2024/07",
  };
}

const names = (entries: readonly BrowseEntry[]) =>
  entries.map((entry) => (entry.kind === "file" ? entry.row.name : entry.id));

describe("review sort", () => {
  it("does not reorder a set when its keeper changes", () => {
    const first = row("a.jpg", 100, "2024-01-01");
    const second = row("z.jpg", 200, "2025-01-01");
    const entry = setEntry("pair", [first, second]);
    expect(setSortModel({ ...entry, keeper: second })).toEqual(setSortModel(entry));
  });
  it("accepts only the three orders the control offers", () => {
    expect(isReviewSort("name")).toBe(true);
    expect(isReviewSort("size")).toBe(true);
    expect(isReviewSort("date")).toBe(true);
    expect(isReviewSort("folder")).toBe(false);
  });

  it("puts the largest and the newest first, and names in ascending order", () => {
    const small = row("a.jpg", 1_000, "2024-01-01T00:00:00Z");
    const large = row("z.jpg", 9_000, "2023-01-01T00:00:00Z");

    expect(sortRows([small, large], "name", "en").map((value) => value.name)).toEqual([
      "a.jpg",
      "z.jpg",
    ]);
    expect(sortRows([small, large], "size", "en").map((value) => value.name)).toEqual([
      "z.jpg",
      "a.jpg",
    ]);
    expect(sortRows([large, small], "date", "en").map((value) => value.name)).toEqual([
      "a.jpg",
      "z.jpg",
    ]);
  });

  it("sorts a file with no date last under newest-first, never first", () => {
    const dated = row("dated.jpg", 10, "2020-05-05T00:00:00Z");
    const undated = row("undated.jpg", 10, null);

    expect(sortRows([undated, dated], "date", "en").map((value) => value.name)).toEqual([
      "dated.jpg",
      "undated.jpg",
    ]);
  });

  it("ranks a set by its largest and latest copy, and by its keeper's name", () => {
    const model = setSortModel(
      setEntry("set-1", [
        row("keeper.jpg", 2_000, "2021-01-01T00:00:00Z"),
        row("other.jpg", 8_000, "2023-06-06T00:00:00Z"),
      ]),
    );

    expect(model).toEqual({ name: "keeper.jpg", size: 8_000, date: "2023-06-06T00:00:00Z" });
  });

  it("orders sets and files against each other on the same fields", () => {
    const entries: BrowseEntry[] = [
      fileEntry(row("solo.jpg", 5_000, "2022-01-01T00:00:00Z")),
      setEntry("set-1", [
        row("b.jpg", 1_000, "2020-01-01T00:00:00Z"),
        row("c.jpg", 9_000, "2024-01-01T00:00:00Z"),
      ]),
    ];

    expect(names(sortEntries(entries, "size", "en"))).toEqual(["set-1", "solo.jpg"]);
    expect(names(sortEntries(entries, "date", "en"))).toEqual(["set-1", "solo.jpg"]);
  });

  it("breaks every tie by name, so the order is total and does not reshuffle", () => {
    const first = rowSortModel(row("a.jpg", 100, "2024-01-01T00:00:00Z"));
    const second = rowSortModel(row("b.jpg", 100, "2024-01-01T00:00:00Z"));

    for (const sort of ["name", "size", "date"] as ReviewSort[]) {
      expect(compareBySort(first, second, sort, "en")).toBeLessThan(0);
      expect(compareBySort(second, first, sort, "en")).toBeGreaterThan(0);
    }
  });
});
