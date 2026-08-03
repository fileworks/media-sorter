import { describe, expect, it } from "vitest";

import {
  centerBadge,
  centerState,
  preflight,
  reportView,
  type OperationSummary,
  type PreflightInput,
} from "@/lib/operationCenter";
import {
  activeCards,
  applyRemap,
  blockingConflicts,
  cardStatus,
  changeRole,
  excludeForRun,
  isWithin,
  remapImpact,
  reorder,
  sourcesReadiness,
  validateRoots,
  type RootCard,
} from "@/lib/sourcesStage";

function card(overrides: Partial<RootCard> = {}): RootCard {
  return {
    rootId: "r1",
    role: "input",
    path: "/library/photos",
    displayName: null,
    priority: 0,
    exclusions: [],
    state: "ready",
    volume: "Macintosh HD",
    freshness: "fresh",
    indexedFiles: 1200,
    issueCount: 0,
    ...overrides,
  };
}

const READY_SET = [
  card({ rootId: "in", role: "input", path: "/library/photos" }),
  card({ rootId: "out", role: "destination", path: "/library/sorted" }),
];

// ── Sources ──────────────────────────────────────────────────────────────────

describe("isWithin", () => {
  it("compares by segment, not by prefix", () => {
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
    expect(isWithin("/a/photos-old", "/a/photos")).toBe(false);
    expect(isWithin("/a", "/a/b")).toBe(false);
  });

  it("ignores trailing slashes, case, and separator style", () => {
    expect(isWithin("C:\\Photos\\2019", "c:/photos/")).toBe(true);
  });
});

describe("validateRoots", () => {
  it("accepts a plain input and destination pair", () => {
    expect(blockingConflicts(validateRoots(READY_SET))).toEqual([]);
    expect(sourcesReadiness(READY_SET).ready).toBe(true);
  });

  it("requires an input and a destination", () => {
    const kinds = validateRoots([]).map((conflict) => conflict.kind);

    expect(kinds).toContain("no_input");
    expect(kinds).toContain("no_destination");
  });

  it("blocks a destination inside an input and names both sides", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/library" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted" }),
    ]);

    const conflict = conflicts.find((item) => item.kind === "destination_inside_input");
    expect(conflict?.rootIds.sort()).toEqual(["in", "out"]);
    expect(conflict?.blocking).toBe(true);
    expect(conflict?.remedy).toBeTruthy();
  });

  it("blocks an input inside the destination", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/sorted/incoming" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ]);

    expect(conflicts.some((item) => item.kind === "input_inside_destination")).toBe(true);
  });

  it("blocks a reference that would be reorganized", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/library" }),
      card({ rootId: "ref", role: "reference", path: "/library/archive" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ]);

    const conflict = conflicts.find((item) => item.kind === "reference_overlaps_mutable");
    expect(conflict?.message).toMatch(/would be changed/i);
  });

  it("accepts sibling folders that merely share a prefix", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/library/photos" }),
      card({ rootId: "ref", role: "reference", path: "/library/photos-archive" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ]);

    expect(blockingConflicts(conflicts)).toEqual([]);
  });

  it("rejects the same folder listed twice", () => {
    const conflicts = validateRoots([
      card({ rootId: "a", role: "input", path: "/library" }),
      card({ rootId: "b", role: "reference", path: "/library/" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ]);

    expect(conflicts.some((item) => item.kind === "duplicate_path")).toBe(true);
  });

  it("allows only one destination", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/a" }),
      card({ rootId: "d1", role: "destination", path: "/b" }),
      card({ rootId: "d2", role: "destination", path: "/c" }),
    ]);

    expect(conflicts.some((item) => item.kind === "multiple_destinations")).toBe(true);
  });

  it("blocks an offline input but only warns about an offline reference", () => {
    const offlineInput = validateRoots([
      card({ rootId: "in", role: "input", state: "offline" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ]).find((item) => item.kind === "offline");
    const offlineReference = validateRoots([
      ...READY_SET,
      card({ rootId: "ref", role: "reference", path: "/nas/library", state: "offline" }),
    ]).find((item) => item.kind === "offline");

    expect(offlineInput?.blocking).toBe(true);
    expect(offlineReference?.blocking).toBe(false);
    expect(offlineReference?.remedy).toMatch(/less complete/i);
  });
});

describe("sources interactions", () => {
  it("reorder keeps the priority order contiguous", () => {
    const cards = [
      card({ rootId: "a", priority: 0 }),
      card({ rootId: "b", priority: 1 }),
      card({ rootId: "c", priority: 2 }),
    ];

    const moved = reorder(cards, "c", -1);

    expect(moved.map((item) => item.rootId)).toEqual(["a", "c", "b"]);
    expect(moved.map((item) => item.priority)).toEqual([0, 1, 2]);
  });

  it("reorder past either end changes nothing", () => {
    const cards = [card({ rootId: "a", priority: 0 })];

    expect(reorder(cards, "a", -1)).toBe(cards);
    expect(reorder(cards, "missing", 1)).toBe(cards);
  });

  it("a role change reports the conflicts it would introduce", () => {
    const cards = [
      card({ rootId: "in", role: "input", path: "/library" }),
      card({ rootId: "sub", role: "input", path: "/library/archive" }),
      card({ rootId: "out", role: "destination", path: "/sorted" }),
    ];

    const change = changeRole(cards, "sub", "reference");

    expect(change.conflicts.some((item) => item.kind === "reference_overlaps_mutable")).toBe(true);
  });

  it("a remap says what it invalidates before it is applied", () => {
    const impact = remapImpact({
      rootId: "r1",
      fromPath: "/old",
      toPath: "/new",
      volumeChanged: true,
    });

    expect(impact.join(" ")).toMatch(/looking at again/i);
    expect(impact.join(" ")).toMatch(/rebuilt/i);
  });

  it("a remapped root loses its freshness rather than keeping a stale claim", () => {
    const [remapped] = applyRemap([card()], {
      rootId: "r1",
      fromPath: "/library/photos",
      toPath: "/volumes/backup/photos",
      volumeChanged: true,
    });

    expect(remapped.path).toBe("/volumes/backup/photos");
    expect(remapped.freshness).toBe("unknown");
    expect(remapped.indexedFiles).toBeNull();
  });

  it("a per-run exclusion hides a root without removing it", () => {
    const excluded = excludeForRun([], "r1");

    expect(excluded).toEqual(["r1"]);
    expect(excludeForRun(excluded, "r1")).toEqual(["r1"]);
    expect(activeCards([card()], excluded)).toEqual([]);
  });
});

describe("cardStatus", () => {
  it("shows a conflict ahead of anything else", () => {
    const conflicts = validateRoots([
      card({ rootId: "in", role: "input", path: "/library" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted" }),
    ]);

    expect(cardStatus(card({ rootId: "out" }), conflicts).tone).toBe("error");
  });

  it("says how much is indexed and how fresh it is", () => {
    const status = cardStatus(card(), []);

    expect(status.tone).toBe("ready");
    expect(status.detail).toMatch(/1,200 files/);
    expect(status.detail).toMatch(/up to date/);
  });

  it("marks a never-scanned folder as unchecked rather than ready", () => {
    expect(cardStatus(card({ state: "unknown" }), []).tone).toBe("warning");
  });
});

describe("probe-driven blocking conflicts", () => {
  const kindsOf = (cards: RootCard[]) =>
    blockingConflicts(validateRoots(cards)).map((conflict) => conflict.kind);

  it("blocks when no input folder can be read", () => {
    const kinds = kindsOf([
      card({ rootId: "in", role: "input", state: "missing" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted" }),
    ]);

    expect(kinds).toContain("no_readable_input");
  });

  it("does not block while an input is still being probed", () => {
    const kinds = kindsOf([
      card({ rootId: "in", role: "input", state: "checking" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted" }),
    ]);

    expect(kinds).not.toContain("no_readable_input");
  });

  it("counts a baseline as no substitute for a readable input", () => {
    const kinds = kindsOf([
      card({ rootId: "in", role: "input", state: "missing" }),
      card({ rootId: "ref", role: "reference", path: "/library/ref", state: "ready" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted" }),
    ]);

    expect(kinds).toContain("no_readable_input");
  });

  it("blocks a destination that is missing, unreadable, or read-only", () => {
    for (const [state, kind] of [
      ["missing", "destination_missing"],
      ["unreadable", "destination_unreadable"],
      ["not_writable", "destination_not_writable"],
    ] as const) {
      const kinds = kindsOf([
        card({ rootId: "in", role: "input", path: "/library/photos" }),
        card({ rootId: "out", role: "destination", path: "/library/sorted", state }),
      ]);

      expect(kinds, state).toContain(kind);
    }
  });

  it("states an unreadable destination once, not twice", () => {
    const kinds = kindsOf([
      card({ rootId: "in", role: "input", path: "/library/photos" }),
      card({ rootId: "out", role: "destination", path: "/library/sorted", state: "unreadable" }),
    ]);

    expect(kinds.filter((kind) => kind === "offline")).toEqual([]);
  });

  it("opens the gate once every probe comes back ready", () => {
    expect(
      kindsOf([
        card({ rootId: "in", role: "input", path: "/library/photos", state: "ready" }),
        card({ rootId: "out", role: "destination", path: "/library/sorted", state: "ready" }),
      ]),
    ).toEqual([]);
  });
});

// ── Operation center ─────────────────────────────────────────────────────────

function operation(overrides: Partial<OperationSummary> = {}): OperationSummary {
  return {
    operationId: "op1",
    kind: "sort",
    startedAt: "2026-07-28T10:00:00Z",
    finishedAt: "2026-07-28T10:05:00Z",
    outcome: "completed",
    counts: {
      verified_success: 10,
      warnings: 0,
      skipped: 0,
      quarantined: 0,
      failed: 0,
      unresolved: 0,
    },
    bytesWritten: 1000,
    reportId: "rep1",
    recoveryState: "none",
    ...overrides,
  };
}

describe("operation center", () => {
  it("separates the running operation from the finished ones", () => {
    const state = centerState([
      operation({ operationId: "old", startedAt: "2026-07-28T09:00:00Z" }),
      operation({ operationId: "live", outcome: null, finishedAt: null }),
    ]);

    expect(state.active?.operationId).toBe("live");
    expect(state.recent.map((item) => item.operationId)).toEqual(["old"]);
  });

  it("counts only unseen, non-clean outcomes as unread", () => {
    const state = centerState([
      operation({ operationId: "clean" }),
      operation({ operationId: "warned", outcome: "completed_with_warnings" }),
    ]);

    expect(state.unread).toEqual(["warned"]);
    expect(
      centerState([operation({ operationId: "warned", outcome: "partial" })], ["warned"]).unread,
    ).toEqual([]);
  });

  it("badges what needs attention above what merely finished", () => {
    const failing = centerState([
      operation({ operationId: "bad", counts: { ...operation().counts, failed: 2 } }),
    ]);

    expect(centerBadge(failing).tone).toBe("error");
    expect(centerBadge(centerState([operation()])).count).toBe(0);
    expect(centerBadge(centerState([operation({ outcome: null, finishedAt: null })])).tone).toBe(
      "info",
    );
  });
});

describe("execute preflight", () => {
  const base: PreflightInput = {
    actionableGroups: 3,
    quarantineCount: 4,
    quarantineBytes: 5_000,
    copyCount: 2,
    moveCount: 0,
    skipCount: 1,
    referenceCount: 1,
    sourceMutations: 0,
    acknowledgedSourceMutations: false,
    staleGroups: 0,
    unresolvedGroups: 0,
    freeBytes: 1_000_000,
    requiredBytes: 10_000,
    quarantineWritable: true,
    conversionWithoutOriginals: 0,
    companionsLeftInPlace: 0,
    embeddedTagCount: 0,
  };

  it("allows a clean plan and summarises exactly what happens", () => {
    const result = preflight(base);

    expect(result.canExecute).toBe(true);
    expect(result.summary.map((line) => line.text).join(" ")).toMatch(/never deleted/i);
    expect(result.summary.map((line) => line.text).join(" ")).toMatch(
      /reference file\(s\) will not be touched/i,
    );
  });

  it("tells indecision apart from a deliberate exclude-everything", () => {
    const undecided = preflight({ ...base, actionableGroups: 0 });
    const excluded = preflight({ ...base, actionableGroups: 0, excludedCount: 12 });

    expect(undecided.canExecute).toBe(false);
    expect(undecided.blocking[0].messageKey).toBe("preflight.blocking.empty");

    // Same zero, opposite advice: one needs a decision, the other needs a file
    // put back. Reporting "nothing has been decided" to somebody who has just
    // decided to exclude everything is a misdiagnosis.
    expect(excluded.canExecute).toBe(false);
    expect(excluded.blocking[0].messageKey).toBe("preflight.blocking.allExcluded");
    expect(excluded.blocking[0].params).toMatchObject({ count: 12 });
  });

  it("blocks on stale review", () => {
    const result = preflight({ ...base, staleGroups: 2 });

    expect(result.canExecute).toBe(false);
    expect(result.blocking[0].text).toMatch(/changed since you reviewed/i);
  });

  it("blocks on insufficient space and says both sizes in human units", () => {
    const result = preflight({ ...base, freeBytes: 1, requiredBytes: 5_000 });

    expect(result.canExecute).toBe(false);
    // Sizes are formatted, not raw byte counts: "5,000 bytes" is a number to
    // decode, "4.9 KB" is a number to read.
    expect(result.blocking[0].text).toMatch(/4\.9 KB needed, 1 B available/);
    expect(result.blocking[0].params).toMatchObject({
      required: "4.9 KB",
      available: "1 B",
    });
  });

  it("blocks on an unwritable quarantine", () => {
    expect(preflight({ ...base, quarantineWritable: false }).canExecute).toBe(false);
  });

  it("requires an acknowledgement for source mutations, then allows it", () => {
    const pending = preflight({ ...base, sourceMutations: 3 });
    const acknowledged = preflight({
      ...base,
      sourceMutations: 3,
      acknowledgedSourceMutations: true,
    });

    expect(pending.canExecute).toBe(false);
    expect(pending.acknowledgement).toMatch(/input folders/i);
    expect(acknowledged.canExecute).toBe(true);
    expect(acknowledged.acknowledgement).toBeNull();
  });

  it("refuses to run when nothing was decided", () => {
    expect(preflight({ ...base, actionableGroups: 0 }).canExecute).toBe(false);
  });

  it("mentions unresolved groups without blocking on them", () => {
    const result = preflight({ ...base, unresolvedGroups: 5 });

    expect(result.canExecute).toBe(true);
    expect(result.summary.some((line) => line.tone === "warning")).toBe(true);
  });

  it("blocks when preview could not freeze every sort outcome", () => {
    const result = preflight({ ...base, unplannedCount: 2 });

    expect(result.canExecute).toBe(false);
    expect(result.blocking[0].text).toMatch(/could not be frozen safely/i);
  });

  it("names every configured irreversible consequence", () => {
    const result = preflight({
      ...base,
      moveCount: 7,
      conversionWithoutOriginals: 4,
      companionsLeftInPlace: 3,
      embeddedTagCount: 2,
    });
    const text = result.irreversible.map((line) => line.text).join(" ");
    expect(text).toMatch(/source file\(s\) will be removed/i);
    expect(text).toMatch(/not be retained after conversion/i);
    expect(text).toMatch(/companion file\(s\).*remain/i);
    expect(text).toMatch(/embedded/i);
    expect(text).toMatch(/quarantine/i);
  });

  it("states explicitly when a copy-only plan has no irreversible effects", () => {
    const result = preflight({
      ...base,
      quarantineCount: 0,
      quarantineBytes: 0,
      conversionWithoutOriginals: 0,
      companionsLeftInPlace: 0,
      embeddedTagCount: 0,
    });
    expect(result.irreversible).toHaveLength(1);
    expect(result.irreversible[0].text).toMatch(/no effects.*remove or rewrite originals/i);
  });
});

describe("reportView", () => {
  it("drops zero counts and links to what exists", () => {
    const view = reportView(operation({ counts: { ...operation().counts, quarantined: 3 } }));

    expect(view.facts.map((fact) => fact.label)).toEqual(["Organized", "Quarantined"]);
    expect(view.links.map((link) => link.kind)).toEqual(["report", "quarantine", "logs"]);
    expect(view.nextSteps.join(" ")).toMatch(/nothing was deleted/i);
  });

  it("links to recovery when a run needs it", () => {
    const view = reportView(operation({ recoveryState: "required" }));

    expect(view.links.some((link) => link.kind === "recovery")).toBe(true);
    expect(view.nextSteps.join(" ")).toMatch(/interrupted/i);
  });

  it("says a running operation is still running", () => {
    expect(reportView(operation({ outcome: null })).headline).toBe("Still running");
  });
});
