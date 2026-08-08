import { describe, expect, it } from "vitest";

import {
  catalogGroupsForRun,
  comparePair,
  selectionActions,
  toReviewRows,
  type ReviewRow,
} from "@/lib/reviewRows";
import type { DuplicateGroup, GroupMember } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

function provenance(
  pathDecision: NonNullable<PreviewItem["provenance"]>["path"][number]["decision"] | null = "date",
  overrides: Partial<NonNullable<PreviewItem["provenance"]>> = {},
): NonNullable<PreviewItem["provenance"]> {
  return {
    date: {
      resolved_date: "2025-07-04",
      winning_source: "filename",
      candidates: [],
    },
    rules: {
      matched_tags: [],
      matched_routes: [],
      winning_route: null,
      route_folder: null,
    },
    categorization: {
      enabled: false,
      label: null,
      confidence: null,
      threshold: null,
      passed: null,
    },
    duplicate: {
      evaluated: false,
      status: "not_evaluated",
      match_kind: null,
      matched_path: null,
      perceptual_distance: null,
    },
    unit: null,
    path:
      pathDecision === null
        ? []
        : [{ segment: "2025", decision: pathDecision, detail: "recorded by the plan" }],
    ...overrides,
  };
}

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

function member(id: string, path: string, role: "input" | "reference" = "input"): GroupMember {
  return {
    member_id: id,
    root_id: "input-a",
    role,
    relative_path: path,
    observed_path: path,
    facts: {
      size_bytes: 10,
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

  it("carries the plan explanation into the row and derives its date reason from it", () => {
    const recorded = provenance();
    const rows = toReviewRows(
      result(
        item({
          extracted_date: "1999-01-01",
          metadata_source: "filesystem",
          provenance: recorded,
        }),
      ),
    );

    expect(rows[0].provenance).toBe(recorded);
    expect(rows[0].reason).toEqual({
      key: "review.reason.date.filename",
      params: { date: "2025-07-04" },
    });
  });

  it.each([
    ["sort", "date", "review.reason.date.filename"],
    ["unknown_date", "quarantine", "review.reason.noDate"],
    ["future_date", "quarantine", "review.reason.futureDate"],
    ["suspicious_date", "quarantine", "review.reason.suspiciousDate"],
    ["duplicate", "quarantine", "review.reason.duplicatePlain"],
    ["junk", "quarantine", "review.reason.junk"],
    ["already_in_destination", "quarantine", "review.reason.alreadyThere"],
    ["keep_in_place", null, "review.reason.keepInPlace"],
  ] as const)(
    "keeps the %s summary aligned with its recorded %s outcome",
    (status, decision, reasonKey) => {
      const recorded = provenance(decision, {
        date: {
          resolved_date: status === "unknown_date" ? null : "2025-07-04",
          winning_source: status === "unknown_date" ? null : "filename",
          candidates: [],
        },
      });
      const row = toReviewRows(
        result(
          item({
            status,
            destination: status === "keep_in_place" ? null : "/out/_held/photo.jpg",
            provenance: recorded,
          }),
        ),
      )[0];

      expect(row.reason.key).toBe(reasonKey);
      expect(row.provenance?.path.map((part) => part.decision)).toEqual(
        decision === null ? [] : [decision],
      );
    },
  );

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

  it("does not turn a library-wide group with one current member into a one-copy set", () => {
    const catalog = stack({
      members: [member("m1", "/in/a.jpg"), member("m2", "/another-run/b.jpg")],
    });
    const current = result(item({ source: "/in/a.jpg" }));
    const rows = toReviewRows(current, [catalog]);

    expect(catalogGroupsForRun(current.items, [catalog])).toEqual([]);
    expect(rows[0].stack).toBeNull();
  });

  it("keeps a catalog set actionable when two current copies remain but its anchor is outside", () => {
    const catalog = stack({
      member_count: 3,
      total_bytes: 30,
      anchor_member_id: "outside",
      members: [
        member("outside", "/another-run/kept.jpg"),
        member("m1", "/in/a.jpg"),
        member("m2", "/in/b.jpg"),
      ],
    });
    const current = result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" }));
    const scoped = catalogGroupsForRun(current.items, [catalog]);
    const rows = toReviewRows(current, [catalog]);

    expect(scoped[0]).toMatchObject({
      member_count: 2,
      total_bytes: 20,
      anchor_member_id: "m1",
    });
    expect(rows.map((row) => row.stack?.size)).toEqual([2, 2]);
    expect(rows.map((row) => row.stack?.isKeeper)).toEqual([true, false]);
  });

  it("lets a review decision override the anchor as keeper", () => {
    const rows = toReviewRows(
      result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })),
      [stack()],
      new Map([["g1", "m2"]]),
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

  it("keeps unreadable and undated files visible at their planned review folders", () => {
    const rows = toReviewRows(
      result(
        item({ source: "/in/ok.jpg" }),
        item({
          source: "/in/broken.jpg",
          destination: "/out/_corrupted/broken.jpg",
          status: "failed",
        }),
        item({
          source: "/in/nodate.jpg",
          destination: "/out/_undated/nodate.jpg",
          status: "unknown_date",
          extracted_date: null,
        }),
      ),
    );

    expect(rows[1]).toMatchObject({
      status: "unreadable",
      destination: "/out/_corrupted/broken.jpg",
      setAsideCategory: "corrupted",
    });
    expect(rows[2]).toMatchObject({
      destination: "/out/_undated/nodate.jpg",
      setAsideCategory: "undated",
    });
  });
});

describe("selectionActions", () => {
  const rows = toReviewRows(result(item({ source: "/in/a.jpg" }), item({ source: "/in/b.jpg" })), [
    stack(),
  ]);

  it("states a reason for every action it will not offer", () => {
    const actions = selectionActions([]);

    expect(actions.reasons.keepOnlyThis).toMatch(/select exactly one/i);
    expect(actions.reasons.compare).toMatch(/exactly two/i);
  });

  it("enables Compare only with exactly two selected", () => {
    expect(selectionActions(rows.slice(0, 1)).canCompare).toBe(false);
    expect(selectionActions(rows).canCompare).toBe(true);
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
