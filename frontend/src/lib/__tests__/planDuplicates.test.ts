/**
 * The reported plan, and the contradiction it produced.
 *
 * A user previewed five files across two folders and was told:
 *
 *   "5 files scanned from 2 folders … 5 will be placed into the new folder
 *    structure, 0 set aside into review folders, and 0 left exactly where they
 *    are. No duplicate sets in this run. Every duplicate set has been decided."
 *
 * while three of the five were bound for `_duplicates/` and nothing on the
 * screen could decide them. The cause was two independent duplicate detections:
 * `PreviewService` marks a file `duplicate` from its own registry match, and the
 * catalog behind `/api/review/groups` is a separate query — and only the catalog
 * ever produced a stack. A file the run was setting aside with no catalog group
 * covering it reached the screen belonging to nothing.
 *
 * This file pins the plan as a fixture. Its assertions are the properties that
 * were false, so a regression here reproduces the report rather than an
 * abstraction of it.
 */

import { describe, expect, it } from "vitest";

import { browseEntries, browseTree, resolveQueue, reviewStats } from "@/lib/reviewBrowse";
import { duplicateTally } from "@/lib/reviewPlan";
import { planDuplicateSets, reviewedSetsFrom, toReviewRows } from "@/lib/reviewRows";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

function item(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    source: "/hdd-a/photo.jpg",
    destination: "/out/2025/07/photo.jpg",
    extracted_date: "2025-07-04",
    metadata_source: "exif",
    tags: [],
    status: "sort",
    file_size: 1000,
    ...overrides,
  } as PreviewItem;
}

function result(...items: PreviewItem[]): PreviewResult {
  return { items } as unknown as PreviewResult;
}

/**
 * The reported run: two source folders, five files. `IMG_0031.jpg` is kept and
 * three copies of it are bound for `_duplicates/`. One unrelated file sorts.
 */
function reportedPlan(): PreviewResult {
  return result(
    item({ source: "/hdd-a/IMG_0031.jpg", destination: "/out/2025/07/IMG_0031.jpg" }),
    item({
      source: "/hdd-a/IMG_0031 (1).jpg",
      destination: "/out/_duplicates/IMG_0031 (1).jpg",
      status: "duplicate",
      duplicate_of: "/hdd-a/IMG_0031.jpg",
      duplicate_type: "exact",
    }),
    item({
      source: "/phone/IMG_0031.jpg",
      destination: "/out/_duplicates/IMG_0031.jpg",
      status: "duplicate",
      duplicate_of: "/hdd-a/IMG_0031.jpg",
      duplicate_type: "exact",
    }),
    item({
      source: "/phone/IMG_0031 copy.jpg",
      destination: "/out/_duplicates/IMG_0031 copy.jpg",
      status: "duplicate",
      duplicate_of: "/hdd-a/IMG_0031.jpg",
      duplicate_type: "exact",
    }),
    item({ source: "/hdd-a/IMG_9000.jpg", destination: "/out/2025/08/IMG_9000.jpg" }),
  );
}

/** Six catalog sets whose other copies are not in this run — the "6 sets". */
function outOfRunGroups(): DuplicateGroup[] {
  return Array.from({ length: 6 }, (_, index) => {
    const id = `cat-${index}`;
    return {
      group_id: id,
      kind: "exact",
      catalog_generation: 1,
      rule_version: "v1",
      member_count: 2,
      total_bytes: 2000,
      anchor_member_id: `${id}:0`,
      evidence_summary: "",
      members: [`/elsewhere/a-${index}.jpg`, `/elsewhere/b-${index}.jpg`].map((path, i) => ({
        member_id: `${id}:${i}`,
        observed_path: path,
        relative_path: path,
        root_id: "elsewhere",
        role: "input",
        facts: {},
        evidence: {},
      })),
    } as unknown as DuplicateGroup;
  });
}

describe("the reported plan", () => {
  const plan = reportedPlan();
  const rows = toReviewRows(plan, []);
  const entries = browseEntries(rows);

  it("attributes every file the run sets aside as a duplicate to a set", () => {
    const orphaned = rows.filter((row) => row.status === "duplicate" && row.stack === null);
    expect(orphaned).toEqual([]);
  });

  it("reports the set the run found, where it once reported none", () => {
    const stats = reviewStats(rows, entries);
    expect(stats.scanned).toBe(5);
    expect(stats.sets).toBe(1);
    // Four members: the kept copy and its three duplicates.
    expect(stats.copies).toBe(3);
  });

  it("offers that set for decision, where the queue was once empty", () => {
    expect(resolveQueue(entries).map((entry) => entry.id)).toEqual(["plan:/hdd-a/IMG_0031.jpg"]);
  });

  it("does not claim every set is decided while one is waiting", () => {
    expect(reviewStats(rows, entries).undecided).toBe(1);
  });

  it("marks the set as found by the run rather than by the catalog", () => {
    const set = resolveQueue(entries)[0];
    expect(set.origin).toBe("plan");
  });

  it("holds the undecided set whole, because the run skips it whole", () => {
    // Every member stays put, including the copy that would have been kept —
    // which is what `sort_plan.py` does with a set nobody has decided.
    const stats = reviewStats(rows, entries);
    expect(stats.staysPut).toBe(4);
    expect(stats.organized).toBe(1);
    expect(stats.setAside).toBe(0);
  });

  it("keeps the tree and the figures describing the same files", () => {
    const stats = reviewStats(rows, entries);
    const tree = browseTree(entries, "Destination");
    const total = (node: { count: number }) => node.count;
    // One entry per placed file, plus one for the set: the tree counts entries
    // and the band counts rows, and both must account for all five files.
    expect(stats.organized + stats.setAside + stats.staysPut).toBe(stats.scanned);
    expect(total(tree)).toBe(entries.length);
  });
});

describe("a decision on a set the run found", () => {
  const plan = reportedPlan();

  it("moves the set out of stays and places the chosen copy", () => {
    const chosen = new Map([["plan:/hdd-a/IMG_0031.jpg", "/phone/IMG_0031.jpg"]]);
    const rows = toReviewRows(plan, [], chosen);
    const entries = browseEntries(rows);
    const stats = reviewStats(rows, entries);

    expect(stats.undecided).toBe(0);
    expect(stats.staysPut).toBe(0);
    // The set places one file and the unrelated photograph places another; the
    // set's other three copies are set aside.
    expect(stats.organized).toBe(2);
    expect(stats.setAside).toBe(3);
  });

  it("files the set where its kept copy lands, not in the duplicates folder", () => {
    // Every copy the run identified was addressed to `_duplicates/`, so reading
    // the chosen keeper's own destination would file the whole set there — the
    // one place it certainly does not go.
    const chosen = new Map([["plan:/hdd-a/IMG_0031.jpg", "/phone/IMG_0031.jpg"]]);
    const entries = browseEntries(toReviewRows(plan, [], chosen));
    const set = entries.find((entry) => entry.kind === "set");
    expect(set?.folder).toBe("out/2025/07");
  });

  it("names the chosen copy as the keeper and the rest as copies of it", () => {
    const chosen = new Map([["plan:/hdd-a/IMG_0031.jpg", "/phone/IMG_0031.jpg"]]);
    const rows = toReviewRows(plan, [], chosen);
    const keeper = rows.find((row) => row.source === "/phone/IMG_0031.jpg");
    const other = rows.find((row) => row.source === "/hdd-a/IMG_0031 (1).jpg");

    expect(keeper?.stack?.isKeeper).toBe(true);
    expect(other?.stack?.isKeeper).toBe(false);
    expect(other?.stack?.keptInstead).toBe("/phone/IMG_0031.jpg");
  });

  it("falls back rather than leaving the set with no keeper when a choice is stale", () => {
    const stale = new Map([["plan:/hdd-a/IMG_0031.jpg", "/gone/vanished.jpg"]]);
    const rows = toReviewRows(plan, [], stale);
    const keepers = rows.filter((row) => row.stack?.isKeeper === true);
    expect(keepers).toHaveLength(1);
  });
});

describe("the destination root is stripped from planned paths", () => {
  const plan = reportedPlan();
  const rows = toReviewRows(plan, []);

  it("recognises a review folder, which it could not while the root was in the path", () => {
    // This is the other half of the report. `_duplicates/` was never the first
    // segment — `/out/_duplicates/x.jpg` began with `out` — so nothing was ever
    // counted as set aside, which is why the summary read "0 set aside into
    // review folders" beside three files bound for exactly that folder.
    const decided = toReviewRows(
      plan,
      [],
      new Map([["plan:/hdd-a/IMG_0031.jpg", "/hdd-a/IMG_0031.jpg"]]),
    );
    const stats = reviewStats(decided, browseEntries(decided, "/out"));
    expect(stats.setAside).toBe(3);
  });

  it("shows the library rather than the machine's directory layout", () => {
    const tree = browseTree(browseEntries(rows, "/out"), "Destination");
    expect(tree.children.map((child) => child.name)).not.toContain("out");
    expect(tree.children.map((child) => child.name)).toContain("2025");
  });

  it("leaves a path outside the root whole rather than mangling it", () => {
    const entries = browseEntries(rows, "/somewhere-else");
    const file = entries.find(
      (entry) => entry.kind === "file" && entry.row.source === "/hdd-a/IMG_9000.jpg",
    );
    expect(file?.folder).toBe("out/2025/08");
  });
});

describe("the decision reaches the run", () => {
  it("sends a plan-found set's keeper and its demoted copies by path", () => {
    const chosen = new Map([["plan:/hdd-a/IMG_0031.jpg", "/phone/IMG_0031.jpg"]]);
    const rows = toReviewRows(reportedPlan(), [], chosen);

    expect(reviewedSetsFrom(rows, chosen)).toEqual([
      {
        keep: "/phone/IMG_0031.jpg",
        demote: ["/hdd-a/IMG_0031.jpg", "/hdd-a/IMG_0031 (1).jpg", "/phone/IMG_0031 copy.jpg"],
      },
    ]);
  });

  it("sends nothing for a set nobody decided", () => {
    const rows = toReviewRows(reportedPlan(), []);
    expect(reviewedSetsFrom(rows, new Map())).toEqual([]);
  });
});

describe("the two detections are reconciled", () => {
  it("counts a file the catalog also holds exactly once", () => {
    const plan = reportedPlan();
    // The catalog holds the same four files as one group.
    const shared = {
      group_id: "cat-shared",
      kind: "exact",
      catalog_generation: 1,
      rule_version: "v1",
      member_count: 4,
      total_bytes: 4000,
      anchor_member_id: "cat-shared:0",
      evidence_summary: "",
      members: [
        "/hdd-a/IMG_0031.jpg",
        "/hdd-a/IMG_0031 (1).jpg",
        "/phone/IMG_0031.jpg",
        "/phone/IMG_0031 copy.jpg",
      ].map((path, index) => ({
        member_id: `cat-shared:${index}`,
        observed_path: path,
        relative_path: path,
        root_id: "hdd-a",
        role: "input",
        facts: {},
        evidence: {},
      })),
    } as unknown as DuplicateGroup;

    const rows = toReviewRows(plan, [shared]);
    const entries = browseEntries(rows);
    const stats = reviewStats(rows, entries);

    expect(stats.sets).toBe(1);
    // The catalog wins the overlap: the set carries catalog identity, so a
    // decision on it survives into the next run.
    expect(resolveQueue(entries)[0].origin).toBe("catalog");
  });

  it("counts a set present in both detections once in the tally", () => {
    const plan = reportedPlan();
    const inScope = new Set(plan.items.map((entry) => entry.source));
    const planSets = planDuplicateSets(plan.items);
    const catalogGroups = [
      {
        id: "cat-shared",
        kind: "exact" as const,
        memberPaths: [
          "/hdd-a/IMG_0031.jpg",
          "/hdd-a/IMG_0031 (1).jpg",
          "/phone/IMG_0031.jpg",
          "/phone/IMG_0031 copy.jpg",
        ],
        decided: false,
      },
    ];

    const tally = duplicateTally(
      [...catalogGroups, ...planSets.map((set) => ({ ...set, decided: false }))],
      inScope,
    );
    expect(tally.sets).toBe(1);
  });

  it("keeps a partial overlap as two sets, because two decisions remain", () => {
    // The catalog holds only two of the four copies. The other two are still
    // duplicates of each other and still need deciding, so folding them into
    // the catalog's set would hide a decision rather than reconcile one.
    const plan = reportedPlan();
    const inScope = new Set(plan.items.map((entry) => entry.source));
    const partial = {
      id: "cat-partial",
      kind: "exact" as const,
      memberPaths: ["/hdd-a/IMG_0031.jpg", "/hdd-a/IMG_0031 (1).jpg"],
      decided: false,
    };
    const planSets = planDuplicateSets(plan.items).map((set) => ({ ...set, decided: false }));

    expect(duplicateTally([partial, ...planSets], inScope).sets).toBe(2);
  });

  it("counts sets whose copies are outside the run separately", () => {
    const plan = reportedPlan();
    const inScope = new Set(plan.items.map((entry) => entry.source));
    const catalog = outOfRunGroups().map((entry) => ({
      id: entry.group_id,
      kind: entry.kind,
      memberPaths: entry.members.map((member) => member.observed_path),
      decided: false,
    }));
    const planSets = planDuplicateSets(plan.items).map((set) => ({ ...set, decided: false }));

    const tally = duplicateTally([...catalog, ...planSets], inScope);
    expect(tally.outOfScope).toBe(6);
    expect(tally.sets).toBe(1);
    expect(tally.unresolved).toBe(1);
  });
});

describe("planDuplicateSets", () => {
  it("needs two members the run holds", () => {
    // The kept copy is not in this run, and there is a single copy of it.
    const plan = result(
      item({
        source: "/phone/only.jpg",
        status: "duplicate",
        duplicate_of: "/elsewhere/original.jpg",
        duplicate_type: "exact",
      }),
    );
    expect(planDuplicateSets(plan.items)).toEqual([]);
  });

  it("forms a set from the copies when the kept file is outside the run", () => {
    const plan = result(
      item({
        source: "/phone/a.jpg",
        status: "duplicate",
        duplicate_of: "/elsewhere/original.jpg",
      }),
      item({
        source: "/phone/b.jpg",
        status: "duplicate",
        duplicate_of: "/elsewhere/original.jpg",
      }),
    );
    const sets = planDuplicateSets(plan.items);
    expect(sets).toHaveLength(1);
    expect(sets[0].memberPaths).toEqual(["/phone/a.jpg", "/phone/b.jpg"]);
  });

  it("reads a perceptual match as a similar set", () => {
    const plan = result(
      item({ source: "/a/keep.jpg" }),
      item({
        source: "/a/near.jpg",
        status: "duplicate",
        duplicate_of: "/a/keep.jpg",
        duplicate_type: "perceptual",
      }),
    );
    expect(planDuplicateSets(plan.items)[0].kind).toBe("similar");
  });

  it("ignores a file with no partner recorded", () => {
    const plan = result(item({ source: "/a/x.jpg", status: "duplicate", duplicate_of: null }));
    expect(planDuplicateSets(plan.items)).toEqual([]);
  });
});
