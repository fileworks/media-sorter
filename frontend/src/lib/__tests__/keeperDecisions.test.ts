/**
 * A keeper decision repaints the set, and leaves with the run.
 *
 * Before this change the decision went to `/api/review/decide`, which wrote a
 * server-side plan nothing read back: `/review/groups` recomputes from the
 * catalog and merges no plan state, so the refetch each decision triggered
 * returned identical data. The screen showed the same thing before and after,
 * and the run did whatever the configured rule said.
 */

import { describe, expect, it } from "vitest";

import { toReviewRows } from "@/lib/reviewRows";
import { keeperByPolicy } from "@/lib/reviewWorkbench";
import type { DuplicateGroup, GroupMember } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

function fact(value: unknown = null, known = value !== null) {
  return { known, value, issue: null };
}

function member(id: string, path: string, overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    member_id: id,
    root_id: "root",
    role: "input",
    relative_path: path.replace("/in/", ""),
    observed_path: path,
    facts: {
      size_bytes: 100,
      modified_at: fact(1000),
      captured_at: fact(),
      width: fact(),
      height: fact(),
      duration_seconds: fact(),
      codec: fact(),
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
    ...overrides,
  };
}

function group(members: GroupMember[], anchor = members[0].member_id): DuplicateGroup {
  return {
    group_id: "g1",
    kind: "exact",
    catalog_generation: 1,
    rule_version: "1",
    member_count: members.length,
    total_bytes: 200,
    anchor_member_id: anchor,
    members,
    evidence_summary: "identical bytes",
  };
}

function item(source: string): PreviewItem {
  return {
    source,
    destination: `/out/2021/${source.split("/").pop()}`,
    status: "sort",
    file_size: 100,
    reason: null,
    companions: [],
    unit_id: null,
    duplicate_evaluation: "checked",
  } as unknown as PreviewItem;
}

function result(...sources: string[]): PreviewResult {
  return {
    items: sources.map(item),
    stats: {
      total: sources.length,
      will_sort: sources.length,
      will_skip_duplicate: 0,
      will_quarantine_junk: 0,
      duplicate_unknown: 0,
    },
    impact: { unresolved_count: 0, required_bytes: 0 },
  } as unknown as PreviewResult;
}

const MEMBERS = [member("m1", "/in/a.jpg"), member("m2", "/in/b.jpg")];

describe("a keeper decision changes the rows", () => {
  it("falls back to the anchor when nothing was decided", () => {
    const rows = toReviewRows(result("/in/a.jpg", "/in/b.jpg"), [group(MEMBERS)], new Map());

    expect(rows[0].stack?.isKeeper).toBe(true);
    expect(rows[1].stack?.isKeeper).toBe(false);
  });

  it("repaints the set from local state, with no request in between", () => {
    const rows = toReviewRows(
      result("/in/a.jpg", "/in/b.jpg"),
      [group(MEMBERS)],
      new Map([["g1", "m2"]]),
    );

    expect(rows[1].stack?.isKeeper).toBe(true);
    expect(rows[0].stack?.isKeeper).toBe(false);
    // And the row that is not kept says which one is, so the change is legible
    // rather than merely present.
    expect(rows[0].stack?.keptInstead).toBe("/in/b.jpg");
  });
});

describe("keep rules decide the same copy the backend would", () => {
  const sized = [
    member("small", "/in/small.jpg", {
      facts: { ...MEMBERS[0].facts, size_bytes: 10, width: fact(100), height: fact(100) },
    }),
    member("large", "/in/large.jpg", {
      facts: { ...MEMBERS[0].facts, size_bytes: 900, width: fact(400), height: fact(400) },
    }),
  ];

  it("largest and smallest are mirror images", () => {
    expect(keeperByPolicy(group(sized), "largest")).toBe("large");
    expect(keeperByPolicy(group(sized), "smallest")).toBe("small");
  });

  it("best quality prefers pixels, then bytes", () => {
    expect(keeperByPolicy(group(sized), "best_quality")).toBe("large");
  });

  it("refuses highest resolution when a member's dimensions are unreadable", () => {
    const partial = [sized[1], member("unknown", "/in/u.jpg")];

    // Treating an unmeasured file as the smallest is how the only good copy
    // gets quarantined. The set goes to a person instead.
    expect(keeperByPolicy(group(partial), "highest_resolution")).toBeNull();
  });

  it("refuses newest when nothing has a usable time", () => {
    const undated = [
      member("x", "/in/x.jpg", { facts: { ...MEMBERS[0].facts, modified_at: fact(null) } }),
    ];

    expect(keeperByPolicy(group(undated), "newest")).toBeNull();
  });

  it("never decides a manual set", () => {
    expect(keeperByPolicy(group(sized), "manual")).toBeNull();
  });

  it("breaks ties on identity, so the result cannot depend on scan order", () => {
    const tied = [member("m2", "/in/b.jpg"), member("m1", "/in/a.jpg")];
    const reversed = [...tied].reverse();

    expect(keeperByPolicy(group(tied), "largest")).toBe(keeperByPolicy(group(reversed), "largest"));
  });
});
