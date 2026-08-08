/**
 * What Browse claims about the plan, asserted without a DOM.
 *
 * Two properties carry the whole surface, and both used to be untrue:
 *
 * - **A folder's count is what selecting it shows.** A duplicate set scattered
 *   between a date folder and `_duplicates/` made the two different numbers.
 * - **Nothing the run skips is invisible.** Undecided sets, baselines and files
 *   already at the destination were badge-level detail or absent, so a run could
 *   skip a set nobody knew was undecided.
 */

import { describe, expect, it } from "vitest";

import {
  STAYS_PATH,
  browseEntries,
  browseTree,
  entriesIn,
  folderGroups,
  folderTrail,
  resolveQueue,
  reviewStats,
  staysDivisionOf,
} from "@/lib/reviewBrowse";
import { toReviewRows } from "@/lib/reviewRows";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

function item(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    source: "/in/photo.jpg",
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

function group(
  id: string,
  members: Array<{ path: string; role?: "input" | "reference" }>,
  kind: "exact" | "similar" | "burst" = "exact",
): DuplicateGroup {
  return {
    group_id: id,
    kind,
    catalog_generation: 1,
    rule_version: "v1",
    member_count: members.length,
    total_bytes: members.length * 1000,
    anchor_member_id: `${id}:0`,
    evidence_summary: "",
    members: members.map((member, index) => ({
      member_id: `${id}:${index}`,
      root_id: "input-a",
      role: member.role ?? "input",
      relative_path: member.path,
      observed_path: member.path,
      facts: {
        size_bytes: 1000,
        modified_at: { known: false, value: null, issue: null },
        captured_at: { known: false, value: null, issue: null },
        width: { known: false, value: null, issue: null },
        height: { known: false, value: null, issue: null },
        duration_seconds: { known: false, value: null, issue: null },
        codec: { known: false, value: null, issue: null },
        media_kind: "image",
      },
      evidence: {
        algorithm: "sha256",
        sha256: null,
        signature: null,
        distance: null,
        threshold: null,
        confidence: "high",
        extraction_issues: [],
      },
    })),
  };
}

/** A plan with one plain file, one undecided set, a baseline and a re-run file. */
function fixture(overrides: { decided?: boolean } = {}) {
  const items = [
    item({ source: "/in/solo.jpg", destination: "/out/2025/07/solo.jpg" }),
    item({ source: "/in/dup-a.jpg", destination: "/out/2025/07/dup-a.jpg" }),
    item({ source: "/in/dup-b.jpg", destination: "/out/_duplicates/dup-b.jpg" }),
    item({ source: "/ref/base.jpg", destination: "/out/2025/07/base.jpg" }),
    item({
      source: "/in/solo2.jpg",
      destination: "/out/_copies/solo2.jpg",
      status: "duplicate",
      duplicate_of: "/ref/base.jpg",
    }),
    item({ source: "/in/known.jpg", destination: null, status: "already_in_destination" }),
  ];
  const groups = [
    group("set-1", [{ path: "/in/dup-a.jpg" }, { path: "/in/dup-b.jpg" }]),
    group("set-base", [{ path: "/ref/base.jpg", role: "reference" }, { path: "/in/solo2.jpg" }]),
  ];
  const overridesMap = overrides.decided ? new Map([["set-1", "set-1:0"]]) : new Map();
  const rows = toReviewRows(result(...items), groups, overridesMap);
  return { rows, entries: browseEntries(rows) };
}

describe("what stays where it is", () => {
  it("places a decided cross-date set in the selected keeper's own folder", () => {
    const rows = toReviewRows(
      result(
        item({
          source: "/in/a.jpg",
          destination: "/out/2019/01/a.jpg",
          would_be_destination: "/out/2019/01/a.jpg",
        }),
        item({
          source: "/in/b.jpg",
          destination: "/out/2019/01/_copies/a — from phone.jpg",
          would_be_destination: "/out/2021/06/b.jpg",
          status: "duplicate",
          duplicate_of: "/in/a.jpg",
        }),
      ),
      [group("cross-date", [{ path: "/in/a.jpg" }, { path: "/in/b.jpg" }])],
      new Map([["cross-date", "cross-date:1"]]),
    );
    const [entry] = browseEntries(rows);

    expect(entry.kind).toBe("set");
    expect(entry.folder).toBe("out/2021/06");
    expect(rows.find((row) => row.source === "/in/a.jpg")?.setAsideCategory).toBe("copy");
    expect(rows.find((row) => row.source === "/in/b.jpg")?.setAsideCategory).toBeNull();
  });

  it("puts an undecided set, a baseline and an already-present file in the branch, once each", () => {
    const { entries } = fixture();

    const stays = entriesIn(entries, STAYS_PATH);
    const folders = stays.map((entry) => entry.folder).sort();

    expect(folders).toEqual([
      `${STAYS_PATH}/already_there`,
      `${STAYS_PATH}/baseline`,
      `${STAYS_PATH}/undecided`,
    ]);

    // And nowhere else: no entry for any of them appears in the date tree.
    const dated = entriesIn(entries, "out/2025/07");
    expect(dated.map((entry) => entry.key)).toEqual(["file:/in/solo.jpg"]);
  });

  it("moves a set out of the branch the moment it is decided", () => {
    const decided = fixture({ decided: true });

    expect(entriesIn(decided.entries, `${STAYS_PATH}/undecided`)).toEqual([]);
    const dated = entriesIn(decided.entries, "out/2025/07").map((entry) => entry.key);
    expect(dated).toContain("set:set-1");
  });

  it("names the division a row belongs to", () => {
    const { rows } = fixture();
    const baseline = rows.find((row) => row.source === "/ref/base.jpg");
    const known = rows.find((row) => row.source === "/in/known.jpg");
    const solo = rows.find((row) => row.source === "/in/solo.jpg");

    expect(staysDivisionOf(baseline!)).toBe("baseline");
    expect(staysDivisionOf(known!)).toBe("already_there");
    expect(staysDivisionOf(solo!)).toBeNull();
  });
});

describe("a set sits where its keeper sits", () => {
  it("treats the tree root and a cleared folder filter as the same whole plan", () => {
    const { entries } = fixture({ decided: true });
    const rootPath = browseTree(entries).path;

    expect(rootPath).toBe("");
    expect(entriesIn(entries, rootPath)).toEqual(entriesIn(entries, null));
    expect(folderGroups(entriesIn(entries, rootPath), rootPath)).toEqual(
      folderGroups(entriesIn(entries, null), null),
    );
  });

  it("counts once, in the keeper's folder, and lists exactly what it counted", () => {
    const { entries } = fixture({ decided: true });
    const tree = browseTree(entries);

    const july = tree.children
      .find((child) => child.name === "out")
      ?.children.find((child) => child.name === "2025")
      ?.children.find((child) => child.name === "07");
    expect(july).toBeDefined();

    // The count and the contents are the same arithmetic, which is the whole
    // reason the set is one entry rather than two rows in two folders.
    expect(july?.count).toBe(entriesIn(entries, "out/2025/07").length);
  });

  /**
   * Selecting a folder must list exactly what its count promised. The tree once
   * split the path into segments while the filter ran `includes()` over the
   * whole string, so `sorted/2019` listed `sorted/2019-backup` too and the
   * count above the list described a different set of files.
   */
  it("does not treat a sibling folder with a shared prefix as a match", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg", destination: "/out/2019/a.jpg" }),
        item({ source: "/in/b.jpg", destination: "/out/2019-backup/b.jpg" }),
      ),
    );
    const entries = browseEntries(rows);

    expect(entriesIn(entries, "out/2019").map((entry) => entry.key)).toEqual(["file:/in/a.jpg"]);
  });

  it("does not match the folder name inside a file name", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/holiday.jpg", destination: "/out/2019/holiday.jpg" }),
        item({ source: "/in/x.jpg", destination: "/out/2020/2019-recap.jpg" }),
      ),
    );
    const entries = browseEntries(rows);

    expect(entriesIn(entries, "out/2019").map((entry) => entry.key)).toEqual([
      "file:/in/holiday.jpg",
    ]);
  });

  it("puts the stays branch last among the root's children", () => {
    const { entries } = fixture();
    const tree = browseTree(entries);

    expect(tree.children[tree.children.length - 1]?.path).toBe(STAYS_PATH);
  });

  it("makes every node's count equal the pane opened by its path", () => {
    const { entries } = fixture();
    const root = browseTree(entries);
    const visit = (node: typeof root): void => {
      expect(entriesIn(entries, node.path)).toHaveLength(node.count);
      node.children.forEach(visit);
    };

    visit(root);
  });
});

describe("one derivation for every figure", () => {
  it("agrees with the queue and with the branch about how many sets are undecided", () => {
    const { rows, entries } = fixture();
    const stats = reviewStats(rows, entries);
    const tree = browseTree(entries);

    const undecidedNode = tree.children
      .find((child) => child.path === STAYS_PATH)
      ?.children.find((child) => child.path === `${STAYS_PATH}/undecided`);

    expect(stats.undecided).toBe(resolveQueue(entries).length);
    expect(stats.undecided).toBe(undecidedNode?.count);
    expect(stats.undecided).toBe(1);
  });

  it("counts every scanned file in exactly one band", () => {
    const { rows, entries } = fixture({ decided: true });
    const stats = reviewStats(rows, entries);

    expect(stats.organized + stats.setAside + stats.staysPut).toBe(stats.scanned);
  });

  it("keeps a baseline set out of the queue — the reference always wins", () => {
    const { entries } = fixture();

    expect(resolveQueue(entries).map((entry) => entry.id)).toEqual(["set-1"]);
  });
});

describe("which subfolder each file lands in", () => {
  /** Two months and a review folder under one year, plus one file in the year. */
  function nested() {
    const rows = toReviewRows(
      result(
        item({ source: "/in/a.jpg", destination: "/out/2019/loose.jpg" }),
        item({ source: "/in/b.jpg", destination: "/out/2019/01/b.jpg" }),
        item({ source: "/in/c.jpg", destination: "/out/2019/01/c.jpg" }),
        item({ source: "/in/d.jpg", destination: "/out/2019/02/d.jpg" }),
        item({ source: "/in/e.jpg", destination: "/out/2019/_junk/e.jpg", status: "junk" }),
        item({ source: "/in/f.jpg", destination: "/out/2020/f.jpg" }),
      ),
      [],
    );
    return browseEntries(rows, "/out");
  }

  it("splits the selected folder by its immediate children", () => {
    const groups = folderGroups(entriesIn(nested(), "2019"), "2019");

    expect(groups.map((group) => group.name)).toEqual(["", "01", "02", "_junk"]);
    expect(groups.map((group) => group.entries.length)).toEqual([1, 2, 1, 1]);
  });

  it("puts what lands in the folder itself first", () => {
    const [first] = folderGroups(entriesIn(nested(), "2019"), "2019");

    expect(first.direct).toBe(true);
    expect(first.path).toBe("2019");
  });

  it("sorts review folders after date folders", () => {
    const groups = folderGroups(entriesIn(nested(), "2019"), "2019");

    expect(groups[groups.length - 1].name).toBe("_junk");
  });

  it("groups the whole plan by its top-level folders when nothing is selected", () => {
    expect(folderGroups(nested(), null).map((group) => group.name)).toEqual(["2019", "2020"]);
  });

  it("keeps a folder's count and the sum of its groups the same arithmetic", () => {
    const entries = nested();
    const node = browseTree(entries, "Destination").children.find((child) => child.name === "2019");
    const groups = folderGroups(entriesIn(entries, "2019"), "2019");

    expect(groups.reduce((sum, group) => sum + group.entries.length, 0)).toBe(node?.count);
  });

  it("never invents a bucket for an entry outside the selection", () => {
    // `entriesIn` normally rules this out; grouping must not silently adopt
    // whatever it is handed, or a stray entry would appear under a folder it
    // does not belong to and inflate that folder's count.
    const groups = folderGroups(nested(), "2019");

    expect(groups.flatMap((group) => group.entries)).toHaveLength(5);
  });

  it("walks the ancestors of a browsing path, outermost first", () => {
    expect(folderTrail("2019/01")).toEqual([
      { path: "2019", name: "2019" },
      { path: "2019/01", name: "01" },
    ]);
    expect(folderTrail(null)).toEqual([]);
  });
});
