import { describe, expect, it } from "vitest";

import {
  applyFilters,
  comparePair,
  excludedTally,
  expandExclusion,
  groupIntoStacks,
  isStack,
  reconcileExclusions,
  rowCounts,
  seedExclusions,
  selectionActions,
  toReviewRows,
  treeFromRows,
  type ReviewRow,
} from "@/lib/reviewRows";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

function item(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    source: "/in/photo.jpg",
    destination: "/out/sorted/2025/07/photo.jpg",
    extracted_date: "2025-07-04",
    metadata_source: "exif",
    tags: [],
    status: "sort",
    file_size: 1000,
    ...overrides,
  } as PreviewItem;
}

function result(...items: PreviewItem[]): PreviewResult {
  return { items, impact: { required_bytes: 0 } } as unknown as PreviewResult;
}

function member(id: string, path: string, role = "input") {
  return {
    member_id: id,
    root_id: "input-a",
    role,
    relative_path: path,
    observed_path: path,
    facts: { size_bytes: 10 },
    evidence: {},
  };
}

function stack(overrides: Partial<DuplicateGroup> = {}): DuplicateGroup {
  return {
    group_id: "g1",
    kind: "exact",
    catalog_generation: 1,
    rule_version: "1",
    member_count: 2,
    total_bytes: 20,
    anchor_member_id: "m1",
    members: [member("m1", "/in/a.jpg"), member("m2", "/in/b.jpg")],
    evidence_summary: "",
    ...overrides,
  } as unknown as DuplicateGroup;
}

describe("toReviewRows", () => {
  it("derives every row from the plan without a per-row fetch", () => {
    const rows = toReviewRows(result(item(), item({ source: "/in/b.jpg" })));

    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("photo.jpg");
    expect(rows[0].folder).toBe("/in");
    expect(rows[0].status).toBe("organize");
  });

  it("maps each preview status to what will actually happen", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/1.jpg", status: "junk" }),
        item({ source: "/in/2.jpg", status: "duplicate" }),
        item({ source: "/in/3.jpg", status: "already_in_destination" }),
        item({ source: "/in/4.jpg", status: "failed" }),
      ),
    );

    expect(rows.map((row) => row.status)).toEqual([
      "junk",
      "duplicate",
      "already_there",
      "unreadable",
    ]);
  });

  it("treats keep_in_place from the deduplicate-only mode as its own status", () => {
    const rows = toReviewRows(
      result(item({ status: "keep_in_place" as PreviewItem["status"], destination: null })),
    );

    expect(rows[0].status).toBe("keep_in_place");
    expect(rows[0].destination).toBeNull();
  });

  it("flags a name clash rather than making it a status", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg", destination: "/out/2025/x.jpg" }),
        item({ source: "/in/b.jpg", destination: "/out/2025/x.jpg" }),
      ),
    );

    // A caveat on a file that is otherwise fine — the sort auto-suffixes it.
    expect(rows[0].flags).toContain("name_clash");
    expect(rows[0].status).toBe("organize");
  });

  it("flags a pending duplicate check as informational, not as a duplicate", () => {
    const rows = toReviewRows(result(item({ duplicate_evaluation: "unknown" })));

    expect(rows[0].flags).toContain("duplicate_pending");
    expect(rows[0].status).toBe("organize");
  });

  it("folds stack membership in, naming what is kept instead", () => {
    const rows = toReviewRows(
      result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })),
      [stack()],
    );

    expect(rows[0].stack?.isKeeper).toBe(true);
    expect(rows[0].stack?.keptInstead).toBeNull();
    expect(rows[1].stack?.isKeeper).toBe(false);
    expect(rows[1].stack?.keptInstead).toBe("/in/a.jpg");
  });

  it("lets a review decision override the anchor as keeper", () => {
    const rows = toReviewRows(
      result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })),
      [stack()],
      { g1: { keeper_member_id: "m2" } as never },
    );

    expect(rows[1].stack?.isKeeper).toBe(true);
    expect(rows[0].stack?.isKeeper).toBe(false);
  });

  it("draws a baseline keeper as a baseline, never as an ordinary row", () => {
    const rows = toReviewRows(
      result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })),
      [
        stack({
          members: [member("m1", "/in/a.jpg", "reference"), member("m2", "/in/b.jpg")],
        } as Partial<DuplicateGroup>),
      ],
    );

    expect(rows[0].status).toBe("baseline");
    expect(rows[0].stack?.hasBaseline).toBe(true);
  });

  it("marks an excluded row as excluded whatever it would otherwise have been", () => {
    const rows = toReviewRows(result(item()), [], {}, new Set(["/in/photo.jpg"]));

    expect(rows[0].status).toBe("excluded");
    expect(rows[0].excluded).toBe(true);
  });
});

describe("groupIntoStacks", () => {
  it("emits a stack for grouped rows and leaves loose rows in place", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg" }),
        item({ source: "/in/b.jpg" }),
        item({ source: "/in/c.jpg" }),
      ),
      [stack()],
    );

    const entries = groupIntoStacks(rows);

    expect(entries).toHaveLength(2);
    expect(isStack(entries[0])).toBe(true);
    expect(isStack(entries[0]) && entries[0].rows).toHaveLength(2);
    expect(isStack(entries[1])).toBe(false);
  });

  it("identifies the stack's keeper", () => {
    const rows = toReviewRows(
      result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })),
      [stack()],
    );

    const [first] = groupIntoStacks(rows);
    expect(isStack(first) && first.keeper?.source).toBe("/in/a.jpg");
  });
});

describe("applyFilters", () => {
  const rows = toReviewRows(
    result(
      item({ source: "/in/keep.jpg" }),
      item({ source: "/in/trash.jpg", status: "junk" }),
      item({ source: "/in/nodate.jpg", status: "unknown_date", extracted_date: null }),
    ),
  );

  it("composes chip, tree and search with AND", () => {
    expect(applyFilters(rows, { filter: "all", search: "", treePath: null })).toHaveLength(3);
    expect(applyFilters(rows, { filter: "junk", search: "", treePath: null })).toHaveLength(1);
    expect(applyFilters(rows, { filter: "all", search: "keep", treePath: null })).toHaveLength(1);
    expect(applyFilters(rows, { filter: "junk", search: "keep", treePath: null })).toHaveLength(0);
  });

  it("matches search against name, source folder and destination", () => {
    expect(applyFilters(rows, { filter: "all", search: "/in", treePath: null })).toHaveLength(3);
    expect(applyFilters(rows, { filter: "all", search: "sorted", treePath: null })).toHaveLength(3);
  });

  it("filters by a destination-tree path", () => {
    expect(applyFilters(rows, { filter: "all", search: "", treePath: "2025/07" })).toHaveLength(3);
    expect(applyFilters(rows, { filter: "all", search: "", treePath: "1999" })).toHaveLength(0);
  });
});

describe("rowCounts", () => {
  it("counts every chip from the same rows the list draws", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg" }),
        item({ source: "/in/b.jpg", status: "junk" }),
        item({ source: "/in/c.jpg", status: "unknown_date", extracted_date: null }),
      ),
    );

    const counts = rowCounts(rows);

    // The bug this prevents: a tile reading "0 duplicates" beside four groups.
    expect(counts.all).toBe(3);
    expect(counts.junk).toBe(1);
    expect(counts.no_date).toBe(1);
    // An undated file is still organised — into `_unknown_dates/`. "No date" is
    // a chip over a file that moves, not a separate destiny, so the chips
    // deliberately overlap and only `all` is the sum.
    expect(counts.organize).toBe(2);
  });
});

describe("treeFromRows", () => {
  it("counts folders from the rows themselves", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
        item({ source: "/in/b.jpg", destination: "/out/2025/08/b.jpg" }),
      ),
    );

    const tree = treeFromRows(rows);

    expect(tree.count).toBe(2);
    const out = tree.children[0];
    expect(out.name).toBe("out");
    expect(out.count).toBe(2);
    expect(out.children.map((child) => child.name)).toEqual(["2025"]);
  });

  it("marks review folders so they read differently from date folders", () => {
    const rows = toReviewRows(result(item({ destination: "/out/_duplicates/a.jpg" })));

    const duplicates = treeFromRows(rows).children[0].children[0];
    expect(duplicates.name).toBe("_duplicates");
    expect(duplicates.isReview).toBe(true);
  });

  it("ignores rows with no destination", () => {
    const rows = toReviewRows(result(item({ destination: null })));

    expect(treeFromRows(rows).count).toBe(0);
  });
});

describe("expandExclusion", () => {
  it("expands any excluded member to its whole unit", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/shot.raw", unit_id: "u1" }),
        item({ source: "/in/shot.jpg", unit_id: "u1" }),
        item({ source: "/in/other.jpg", unit_id: "u2" }),
      ),
    );

    const expanded = expandExclusion(rows, ["/in/shot.jpg"]);

    expect(expanded).toEqual(new Set(["/in/shot.jpg", "/in/shot.raw"]));
  });

  it("leaves a file with no unit alone", () => {
    const rows = toReviewRows(result(item({ source: "/in/a.jpg" })));

    expect(expandExclusion(rows, ["/in/a.jpg"])).toEqual(new Set(["/in/a.jpg"]));
  });
});

describe("seedExclusions", () => {
  it("starts unreadable and undated files excluded", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/ok.jpg" }),
        item({ source: "/in/broken.jpg", status: "failed" }),
        item({ source: "/in/nodate.jpg", status: "unknown_date", extracted_date: null }),
      ),
    );

    expect(seedExclusions(rows)).toEqual(new Set(["/in/broken.jpg", "/in/nodate.jpg"]));
  });
});

describe("reconcileExclusions", () => {
  it("keeps exclusions whose file is still in the plan and reports the rest", () => {
    const rows = toReviewRows(result(item({ source: "/in/a.jpg" })));

    const { kept, dropped } = reconcileExclusions(rows, new Set(["/in/a.jpg", "/in/gone.jpg"]));

    expect(kept).toEqual(new Set(["/in/a.jpg"]));
    expect(dropped).toBe(1);
  });
});

describe("selectionActions", () => {
  const rows = toReviewRows(result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })), [
    stack(),
  ]);

  it("states a reason for every action it will not offer", () => {
    const actions = selectionActions([]);

    expect(actions.canExclude).toBe(false);
    expect(actions.reasons.exclude).toMatch(/select a file/i);
    expect(actions.reasons.compare).toMatch(/exactly two/i);
  });

  it("enables Compare only with exactly two selected", () => {
    expect(selectionActions(rows.slice(0, 1)).canCompare).toBe(false);
    expect(selectionActions(rows).canCompare).toBe(true);
  });

  it("refuses to exclude a baseline and says why", () => {
    const baselineRows = toReviewRows(result(item({ source: "/in/a.jpg" })), [
      stack({
        members: [member("m1", "/in/a.jpg", "reference"), member("m2", "/in/b.jpg")],
      } as Partial<DuplicateGroup>),
    ]);

    const actions = selectionActions(baselineRows);

    expect(actions.canExclude).toBe(false);
    expect(actions.reasons.exclude).toMatch(/never changed/i);
  });

  it("offers Keep only this for exactly one member of a stack", () => {
    expect(selectionActions(rows.slice(0, 1)).canKeepOnlyThis).toBe(true);
    expect(selectionActions(rows).canKeepOnlyThis).toBe(false);
  });
});

describe("comparePair", () => {
  const rows: ReviewRow[] = toReviewRows(
    result(
      item({ source: "/in/a.jpg" }),
      item({ source: "/in/b.jpg" }),
      item({ source: "/in/c.jpg" }),
    ),
  );

  it("is the two rows chosen, never an arbitrary partner", () => {
    const pair = comparePair([rows[0], rows[2]]);

    expect(pair?.[0].source).toBe("/in/a.jpg");
    expect(pair?.[1].source).toBe("/in/c.jpg");
  });

  it("refuses anything that is not exactly two", () => {
    expect(comparePair([rows[0]])).toBeNull();
    expect(comparePair(rows)).toBeNull();
  });
});

describe("excludedTally", () => {
  it("splits what the exclusions take off the plan by where it would have gone", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg", file_size: 100 }),
        item({ source: "/in/b.jpg", status: "junk", file_size: 200 }),
        item({ source: "/in/c.jpg", file_size: 400 }),
      ),
      [],
      {},
      new Set(["/in/a.jpg", "/in/b.jpg"]),
    );

    // The Execute preflight subtracts these, so an excluded file cannot appear
    // in "will be relocated to quarantine".
    expect(excludedTally(rows)).toEqual({ transfers: 1, quarantine: 1, bytes: 300 });
  });

  it("counts nothing when nothing is excluded", () => {
    const rows = toReviewRows(result(item()));

    expect(excludedTally(rows)).toEqual({ transfers: 0, quarantine: 0, bytes: 0 });
  });

  it("remembers what an excluded file would have done", () => {
    const rows = toReviewRows(result(item({ status: "junk" })), [], {}, new Set(["/in/photo.jpg"]));

    expect(rows[0].status).toBe("excluded");
    expect(rows[0].plannedStatus).toBe("junk");
  });
});
