import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTERS,
  availableActions,
  bulkImpactView,
  deserializeUiState,
  factLabel,
  factTitle,
  filterKey,
  filterRows,
  groupRow,
  lowestConfidence,
  nextUnresolved,
  outcomeLabel,
  outcomeTone,
  resolutionLabel,
  serializeUiState,
  type BulkImpact,
  type DuplicateGroup,
  type GroupMember,
  type GroupPlan,
  type ResolvedOutcome,
} from "@/lib/reviewWorkbench";
import { fixedWindow } from "@/hooks/useVirtualWindow";

function fact(value: unknown, issue: string | null = null) {
  return { known: value !== null && value !== undefined, value: value ?? null, issue };
}

function member(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    member_id: "m1",
    root_id: "input-a",
    role: "input",
    relative_path: "2019/holiday.jpg",
    observed_path: "/library/2019/holiday.jpg",
    facts: {
      size_bytes: 1_000,
      modified_at: fact(1_700_000),
      captured_at: fact(null, "no capture date"),
      width: fact(4000),
      height: fact(3000),
      duration_seconds: fact(null, "not a video"),
      codec: fact(null, "not reported"),
      media_kind: "image",
    },
    evidence: {
      algorithm: "sha256",
      sha256: "a".repeat(64),
      signature: null,
      distance: null,
      threshold: null,
      confidence: "high",
      extraction_issues: [],
    },
    ...overrides,
  };
}

function group(overrides: Partial<DuplicateGroup> = {}): DuplicateGroup {
  const members = overrides.members ?? [
    member({ member_id: "a", facts: { ...member().facts, size_bytes: 900 } }),
    member({
      member_id: "b",
      relative_path: "copy.jpg",
      facts: { ...member().facts, size_bytes: 100 },
    }),
  ];
  return {
    group_id: "g1",
    kind: "exact",
    catalog_generation: 3,
    rule_version: "exact-1",
    member_count: members.length,
    total_bytes: members.reduce((sum, item) => sum + item.facts.size_bytes, 0),
    anchor_member_id: null,
    evidence_summary: "identical content",
    ...overrides,
    members,
  };
}

function plan(overrides: Partial<GroupPlan> = {}): GroupPlan {
  return {
    group_id: "g1",
    kind: "exact",
    state: "unresolved",
    decisions: [],
    outcomes: [],
    keeper_member_id: null,
    additional_keeps: [],
    stale_reason: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<ResolvedOutcome> = {}): ResolvedOutcome {
  return {
    member_id: "a",
    kind: "quarantine",
    destination_path: null,
    mutates_source: false,
    requires_acknowledgement: false,
    blocked_reason: null,
    explanation: "",
    ...overrides,
  };
}

describe("facts", () => {
  it("shows unknown rather than a fabricated zero", () => {
    expect(factLabel(fact(null, "dimensions could not be read"))).toBe("unknown");
    expect(factTitle(fact(null, "dimensions could not be read"))).toBe(
      "dimensions could not be read",
    );
  });

  it("formats a known fact and offers no tooltip", () => {
    expect(factLabel(fact(1024), (value) => `${value} B`)).toBe("1024 B");
    expect(factTitle(fact(1024))).toBeUndefined();
  });

  it("refuses to guess a resolution from half a pair", () => {
    const facts = { ...member().facts, height: fact(null, "unreadable") };

    expect(resolutionLabel(facts)).toBe("unknown");
  });
});

describe("groupRow", () => {
  it("counts only what could actually be reclaimed", () => {
    const row = groupRow(group(), plan({ keeper_member_id: "a" }));

    expect(row.potentialBytes).toBe(100);
    expect(row.representativePath).toBe("2019/holiday.jpg");
  });

  it("never counts a protected reference as reclaimable", () => {
    const withReference = group({
      members: [
        member({ member_id: "a" }),
        member({ member_id: "ref", role: "reference", root_id: "library" }),
      ],
    });

    const row = groupRow(withReference, plan({ keeper_member_id: "a" }));

    expect(row.potentialBytes).toBe(0);
    expect(row.hasReference).toBe(true);
  });

  it("reports the weakest evidence in the group", () => {
    const mixed = group({
      members: [
        member({ member_id: "a" }),
        member({
          member_id: "b",
          evidence: { ...member().evidence, confidence: "low" },
        }),
      ],
    });

    expect(groupRow(mixed, undefined).confidence).toBe("low");
    expect(lowestConfidence([])).toBe("unknown");
  });

  it("surfaces a stale reason from the plan", () => {
    const row = groupRow(group(), plan({ state: "stale", stale_reason: "content changed" }));

    expect(row.state).toBe("stale");
    expect(row.staleReason).toBe("content changed");
  });
});

describe("filters", () => {
  const rows = [
    groupRow(group({ group_id: "g1" }), plan({ state: "unresolved" })),
    groupRow(group({ group_id: "g2", kind: "similar" }), plan({ state: "reviewed" })),
  ];

  it("filters by kind and state", () => {
    expect(filterRows(rows, { ...DEFAULT_FILTERS, kind: "similar" })).toHaveLength(1);
    expect(filterRows(rows, { ...DEFAULT_FILTERS, state: "reviewed" })).toHaveLength(1);
  });

  it("filters by search and size", () => {
    expect(filterRows(rows, { ...DEFAULT_FILTERS, search: "holiday" })).toHaveLength(2);
    expect(filterRows(rows, { ...DEFAULT_FILTERS, search: "nothing" })).toHaveLength(0);
    expect(filterRows(rows, { ...DEFAULT_FILTERS, minBytes: 10_000 })).toHaveLength(0);
  });

  it("changes its key whenever the visible scope changes", () => {
    const base = filterKey(DEFAULT_FILTERS, 3);

    expect(filterKey(DEFAULT_FILTERS, 4)).not.toBe(base);
    expect(filterKey({ ...DEFAULT_FILTERS, kind: "exact" }, 3)).not.toBe(base);
    expect(filterKey({ ...DEFAULT_FILTERS, search: " Holiday " }, 3)).toBe(
      filterKey({ ...DEFAULT_FILTERS, search: "holiday" }, 3),
    );
  });
});

describe("fixedWindow", () => {
  it("renders a bounded slice of a huge list", () => {
    const window = fixedWindow(1_000_000, 50_000, 600, 40);

    expect(window.end - window.start).toBeLessThan(40);
    expect(window.totalHeight).toBe(40_000_000);
  });

  it("never starts before the beginning", () => {
    expect(fixedWindow(100, 0, 600, 40).start).toBe(0);
  });

  it("clamps the end to the row count", () => {
    expect(fixedWindow(10, 0, 6_000, 40).end).toBe(10);
  });

  it("survives a zero row height", () => {
    expect(() => fixedWindow(10, 0, 600, 0)).not.toThrow();
  });
});

describe("availableActions", () => {
  it("offers a reference nothing, and explains why", () => {
    const reference = member({ member_id: "ref", role: "reference" });

    const actions = availableActions(reference, group(), undefined);

    expect(actions.every((action) => !action.enabled)).toBe(true);
    expect(actions[0].disabledReason).toMatch(/never changed/i);
  });

  it("offers keeper replacement only for exact groups", () => {
    const exact = availableActions(member(), group(), undefined).map((a) => a.action);
    const similar = availableActions(member(), group({ kind: "similar" }), undefined).map(
      (a) => a.action,
    );

    expect(exact).toContain("replace_keeper");
    expect(similar).toContain("keep_additional");
    expect(similar).not.toContain("replace_keeper");
  });

  it("never offers permanent deletion", () => {
    const actions = availableActions(member(), group(), undefined).map((a) => a.action);

    expect(actions.join(",")).not.toMatch(/delete/i);
  });

  it("disables keeping the file that is already the keeper", () => {
    const actions = availableActions(
      member({ member_id: "a" }),
      group(),
      plan({ keeper_member_id: "a" }),
    );

    expect(actions.find((action) => action.action === "keep")?.enabled).toBe(false);
  });
});

describe("outcomes", () => {
  it("uses the backend explanation when it has one", () => {
    expect(outcomeLabel(outcome({ explanation: "Moved to quarantine" }))).toBe(
      "Moved to quarantine",
    );
  });

  it("falls back to a plain-language default", () => {
    expect(outcomeLabel(outcome({ kind: "no_action_reference" }))).toMatch(/nothing will touch/i);
  });

  it("warns when an action changes a source file", () => {
    expect(outcomeTone(outcome({ mutates_source: true }))).toBe("warning");
    expect(outcomeTone(outcome({ kind: "blocked" }))).toBe("danger");
    expect(outcomeTone(outcome())).toBe("neutral");
  });
});

describe("nextUnresolved", () => {
  const rows = [
    groupRow(group({ group_id: "g1" }), plan({ state: "reviewed" })),
    groupRow(group({ group_id: "g2" }), plan({ state: "unresolved" })),
    groupRow(group({ group_id: "g3" }), plan({ state: "stale" })),
  ];

  it("finds the next group still needing a decision", () => {
    expect(nextUnresolved(rows, null)).toBe("g2");
    expect(nextUnresolved(rows, "g2")).toBe("g3");
  });

  it("wraps around rather than dead-ending", () => {
    expect(nextUnresolved(rows, "g3")).toBe("g2");
  });

  it("returns nothing when everything is reviewed", () => {
    const done = [groupRow(group(), plan({ state: "reviewed" }))];

    expect(nextUnresolved(done, null)).toBeNull();
    expect(nextUnresolved([], null)).toBeNull();
  });
});

describe("bulkImpactView", () => {
  const impact: BulkImpact = {
    scope: "all_unresolved_exact",
    scope_generation: "gen-1",
    matched_groups: 12,
    matched_members: 30,
    skipped_groups: 2,
    skipped_reasons: ["g9: nothing to act on"],
    source_mutations: 5,
    quarantine_bytes: 5_000,
    similar_groups_excluded: true,
  };

  it("states members, bytes, and that nothing is deleted", () => {
    const view = bulkImpactView(impact, "gen-1");

    expect(view.invalidated).toBe(false);
    expect(view.lines.join(" ")).toMatch(/nothing is deleted/i);
    expect(view.lines.join(" ")).toMatch(/30 file\(s\)/);
  });

  it("calls out source mutations and demands acknowledgement", () => {
    const view = bulkImpactView(impact, "gen-1");

    expect(view.requiresAcknowledgement).toBe(true);
    expect(view.lines.join(" ")).toMatch(/input folders/i);
  });

  it("invalidates itself when the scope moved", () => {
    const view = bulkImpactView(impact, "gen-2");

    expect(view.invalidated).toBe(true);
    expect(view.headline).toMatch(/preview this again/i);
  });

  it("says similar groups are excluded", () => {
    expect(bulkImpactView(impact, "gen-1").lines.join(" ")).toMatch(/not included/i);
  });
});

describe("ui state", () => {
  it("round-trips view, filters, and selection", () => {
    const restored = deserializeUiState(
      serializeUiState({
        filters: { ...DEFAULT_FILTERS, kind: "exact" },
        selectedGroupId: "g7",
        scrollTop: 320.6,
        view: "exact",
      }),
    );

    expect(restored.filters.kind).toBe("exact");
    expect(restored.selectedGroupId).toBe("g7");
    expect(restored.scrollTop).toBe(321);
    expect(restored.view).toBe("exact");
  });

  it("never persists a search that could contain a path", () => {
    const raw = serializeUiState({
      filters: { ...DEFAULT_FILTERS, search: "/Users/someone/Pictures" },
      selectedGroupId: null,
      scrollTop: 0,
      view: "overview",
    });

    expect(raw).not.toContain("Users");
  });

  it("falls back to defaults for missing or damaged state", () => {
    expect(deserializeUiState(null).view).toBe("overview");
    expect(deserializeUiState("{not json").filters).toEqual(DEFAULT_FILTERS);
  });
});
