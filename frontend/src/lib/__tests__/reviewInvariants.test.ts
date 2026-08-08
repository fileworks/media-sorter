import { describe, expect, it } from "vitest";

import {
  browseEntries,
  browseTree,
  duplicateSetEntries,
  entriesIn,
  folderGroups,
  resolveQueue,
  reviewStats,
  type BrowseEntry,
  type SetEntry,
} from "@/lib/reviewBrowse";
import { reviewedSetsFrom, toReviewRows, type ReviewRow } from "@/lib/reviewRows";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import {
  isOutstandingState,
  isProposedState,
  isUndecidedState,
  type DuplicateDecision,
  type KeeperProposal,
} from "@/lib/duplicateDecisions";
import { readiness, type StageInputs } from "@/lib/stageModel";
import type { PreviewItem, PreviewResult } from "@/types/api";

/**
 * A small deterministic generator for the Review surface's pure derivations.
 *
 * Keep every generated-plan invariant in this file. Adding a new shape to the
 * generator therefore exercises every agreement below, rather than only the
 * assertion that happened to motivate the new shape.
 */
class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)];
  }
}

const STATUSES: readonly PreviewItem["status"][] = [
  "sort",
  "unknown_date",
  "future_date",
  "failed",
  "suspicious_date",
  "junk",
  "already_in_destination",
  "duplicate_unknown",
  "review_only",
  "keep_in_place",
];

const REVIEW_DESTINATIONS: Partial<Record<PreviewItem["status"], string>> = {
  unknown_date: "_undated",
  future_date: "_undated",
  failed: "_corrupted",
  junk: "_junk",
};

function previewItem(
  source: string,
  status: PreviewItem["status"],
  destination: string | null,
  overrides: Partial<PreviewItem> = {},
): PreviewItem {
  return {
    source,
    destination,
    extracted_date:
      status === "unknown_date" || status === "failed" || status === "keep_in_place"
        ? null
        : "2024-06-15",
    metadata_source: status === "unknown_date" ? "none" : "exif",
    tags: [],
    status,
    file_size: 1_000,
    ...overrides,
  };
}

function group(
  id: string,
  paths: readonly string[],
  options: {
    baseline?: boolean;
    kind?: DuplicateGroup["kind"];
    anchor?: number;
  } = {},
): DuplicateGroup {
  const { baseline = false, kind = "exact", anchor = 0 } = options;
  return {
    group_id: id,
    kind,
    catalog_generation: 1,
    rule_version: "generated-v1",
    member_count: paths.length,
    total_bytes: paths.length * 1_000,
    anchor_member_id: `${id}:${anchor}`,
    evidence_summary: `generated ${kind} set`,
    members: paths.map((path, index) => ({
      member_id: `${id}:${index}`,
      root_id: baseline && index === 0 ? "reference" : "input",
      role: baseline && index === 0 ? "reference" : "input",
      relative_path: path.split("/").pop() ?? path,
      observed_path: path,
      facts: {
        size_bytes: 1_000 + index,
        modified_at: { known: true, value: 1_700_000_000 + index, issue: null },
        captured_at: { known: true, value: `2024-0${(index % 8) + 1}-15`, issue: null },
        width: { known: true, value: 1_920 + index, issue: null },
        height: { known: true, value: 1_080 + index, issue: null },
        duration_seconds: { known: false, value: null, issue: null },
        codec: { known: false, value: null, issue: null },
        media_kind: "image",
      },
      evidence: {
        algorithm: kind === "similar" ? "phash" : "sha256",
        sha256: kind === "exact" ? `hash-${id}` : null,
        signature: null,
        distance: kind === "similar" ? index : null,
        threshold: kind === "similar" ? 8 : null,
        confidence: "high",
        extraction_issues: [],
      },
    })),
  };
}

function previewResult(items: PreviewItem[]): PreviewResult {
  const count = (status: PreviewItem["status"]) =>
    items.filter((item) => item.status === status).length;
  return {
    config_fingerprint: "generated-config",
    plan_id: "generated-plan",
    impact: {
      actionable_groups: items.length,
      copy_count: count("sort"),
      move_count: 0,
      quarantine_count:
        count("unknown_date") + count("future_date") + count("failed") + count("junk"),
      quarantine_bytes: 0,
      skip_count: count("duplicate") + count("already_in_destination") + count("keep_in_place"),
      source_mutations: 0,
      required_bytes: 0,
      conversion_without_originals: 0,
      companions_left_in_place: 0,
      embedded_tag_count: 0,
      unresolved_count: 0,
    },
    items,
    stats: {
      total: items.length,
      will_sort: count("sort") + count("suspicious_date"),
      will_fail: count("failed"),
      will_quarantine_unknown: count("unknown_date"),
      will_quarantine_future: count("future_date"),
      will_skip_duplicate: count("duplicate"),
      will_quarantine_junk: count("junk"),
      will_skip_already_in_destination: count("already_in_destination"),
      duplicate_unknown: count("duplicate_unknown"),
      uncategorized: 0,
    },
    partial: false,
    issues: [],
  };
}

interface GeneratedPlan {
  seed: number;
  result: PreviewResult;
  groups: DuplicateGroup[];
  decisions: Map<string, DuplicateDecision>;
  proposals: Map<string, KeeperProposal>;
}

function generatedPlan(seed: number): GeneratedPlan {
  if (seed === 0) {
    return {
      seed,
      result: previewResult([]),
      groups: [],
      decisions: new Map(),
      proposals: new Map(),
    };
  }

  const random = new Random(seed);
  const items: PreviewItem[] = [];
  const groups: DuplicateGroup[] = [];
  const decisions = new Map<string, DuplicateDecision>();
  const proposals = new Map<string, KeeperProposal>();

  const catalogState = (id: string, memberIds: readonly string[]): void => {
    const state = random.int(0, 3);
    const memberId = random.pick(memberIds);
    if (state === 1) proposals.set(id, { memberId, policy: "newest" });
    if (state === 2) decisions.set(id, { kind: "keeper", memberId });
    if (state === 3) decisions.set(id, { kind: "keep_all" });
  };

  const planState = (id: string, memberPaths: readonly string[]): void => {
    const state = random.int(0, 2);
    if (state === 1) decisions.set(id, { kind: "keeper", memberId: random.pick(memberPaths) });
    if (state === 2) decisions.set(id, { kind: "keep_all" });
  };

  // Every seed carries a rotating subset of ordinary outcomes. Across the
  // corpus this covers every preview status and paths from the root through
  // several nested date/category levels.
  const ordinaryCount = random.int(3, STATUSES.length);
  for (let index = 0; index < ordinaryCount; index += 1) {
    const status = STATUSES[(seed + index) % STATUSES.length];
    const source = `/input-${index % 3}/ordinary-${seed}-${index}.jpg`;
    const reviewFolder = REVIEW_DESTINATIONS[status];
    const depth = random.int(0, 3);
    const dateSegments = ["2024", "06", "events"].slice(0, depth);
    const destination =
      status === "keep_in_place" || status === "review_only" || status === "already_in_destination"
        ? null
        : `/destination/${reviewFolder ?? dateSegments.join("/")}/${source.split("/").pop()}`;
    items.push(previewItem(source, status, destination));
  }

  // A media unit whose companions are also rows. This catches derivations that
  // accidentally count the primary's companion metadata as another file.
  const unitId = `unit-${seed}`;
  const primary = `/input-unit/photo-${seed}.jpg`;
  const raw = `/input-unit/photo-${seed}.raw`;
  items.push(
    previewItem(primary, "sort", `/destination/2023/12/photo-${seed}.jpg`, {
      unit_id: unitId,
      unit_primary: true,
      companions: [
        {
          source: raw,
          destination: `/destination/2023/12/photo-${seed}.raw`,
          role: "raw_sibling",
          status: "attached",
        },
      ],
    }),
    previewItem(raw, "sort", `/destination/2023/12/photo-${seed}.raw`, {
      unit_id: unitId,
      unit_primary: false,
    }),
  );

  // A catalog set of two or many, with members deliberately spanning dates.
  const catalogSize = random.bool() ? 2 : random.int(3, 5);
  const catalogPaths = Array.from(
    { length: catalogSize },
    (_, index) => `/input-catalog/set-${seed}-${index}.jpg`,
  );
  catalogPaths.forEach((path, index) => {
    items.push(
      previewItem(
        path,
        index === 0 ? "sort" : "duplicate",
        index === 0
          ? `/destination/2021/01/catalog-${seed}-0.jpg`
          : `/destination/2021/01/_copies/catalog-${seed}-0 — from input-catalog.jpg`,
        index === 0
          ? { would_be_destination: `/destination/2021/01/catalog-${seed}-0.jpg` }
          : {
              duplicate_of: catalogPaths[0],
              duplicate_type: "exact",
              would_be_destination: `/destination/202${index + 1}/0${index + 1}/catalog-${seed}-${index}.jpg`,
            },
      ),
    );
  });
  const catalogId = `catalog-${seed}`;
  groups.push(group(catalogId, catalogPaths, { kind: random.bool() ? "exact" : "similar" }));
  catalogState(
    catalogId,
    catalogPaths.map((_, index) => `${catalogId}:${index}`),
  );

  // A baseline set is already decided by the reference and never enters the
  // resolve queue.
  const baselinePaths = [`/reference/baseline-${seed}.jpg`, `/input-baseline/copy-${seed}.jpg`];
  items.push(
    previewItem(baselinePaths[0], "sort", `/destination/2020/01/baseline-${seed}.jpg`),
    previewItem(
      baselinePaths[1],
      "duplicate",
      `/destination/2020/01/_copies/baseline-${seed} — from input-baseline.jpg`,
      {
        duplicate_of: baselinePaths[0],
        duplicate_type: "exact",
        would_be_destination: `/destination/2024/06/copy-${seed}.jpg`,
      },
    ),
  );
  groups.push(group(`baseline-${seed}`, baselinePaths, { baseline: true }));

  // A set found only by the plan. `duplicate_of` is its durable relationship;
  // there are intentionally no catalog member records for it.
  const planSize = random.bool() ? 2 : random.int(3, 4);
  const planPaths = Array.from(
    { length: planSize },
    (_, index) => `/input-plan/set-${seed}-${index}.jpg`,
  );
  items.push(previewItem(planPaths[0], "sort", `/destination/2022/09/plan-${seed}-0.jpg`));
  planPaths.slice(1).forEach((path, index) => {
    items.push(
      previewItem(
        path,
        "duplicate",
        `/destination/2022/09/_copies/plan-${seed}-0 — from input-plan.jpg`,
        {
          duplicate_of: planPaths[0],
          duplicate_type: random.bool() ? "exact" : "perceptual",
          would_be_destination: `/destination/202${index + 3}/0${index + 1}/plan-${seed}-${index + 1}.jpg`,
        },
      ),
    );
  });
  const planId = `plan:${planPaths[0]}`;
  planState(planId, planPaths);

  // On some seeds the catalog also sees the plan set. The catalog must claim
  // it once, never leave a second plan-derived entry behind.
  if (seed % 4 === 0) {
    const overlapId = `overlap-${seed}`;
    groups.push(group(overlapId, planPaths, { kind: "exact" }));
    decisions.delete(planId);
    proposals.delete(planId);
    catalogState(
      overlapId,
      planPaths.map((_, index) => `${overlapId}:${index}`),
    );
  }

  return { seed, result: previewResult(items), groups, decisions, proposals };
}

function rowsOf(plan: GeneratedPlan): ReviewRow[] {
  return toReviewRows(plan.result, plan.groups, plan.decisions, plan.proposals);
}

function entryRows(entry: BrowseEntry): ReviewRow[] {
  return entry.kind === "set" ? entry.rows : [entry.row];
}

function walkTree(node: ReturnType<typeof browseTree>): ReturnType<typeof browseTree>[] {
  return [node, ...node.children.flatMap(walkTree)];
}

function expectedDecision(
  entry: SetEntry,
): { keep: string; demote: string[]; keep_all?: boolean } | null {
  const actionable = entry.rows.filter((row) => row.status !== "baseline");
  if (actionable.length === 0) return null;
  if (entry.decisionKind === "keep_all") {
    return {
      keep: actionable[0].source,
      demote: actionable.slice(1).map((row) => row.source),
      keep_all: true,
    };
  }
  const keeper = actionable.find((row) => row.stack?.isKeeper === true) ?? actionable[0];
  return {
    keep: keeper.source,
    demote: actionable.filter((row) => row !== keeper).map((row) => row.source),
  };
}

const DEVELOPMENT_SEEDS = Array.from({ length: 64 }, (_, index) => index);
const ACCEPTANCE_SEEDS = Array.from(
  { length: 512 },
  (_, index) => index + DEVELOPMENT_SEEDS.length,
);

function assertPlanInvariants(seed: number): void {
  const plan = generatedPlan(seed);
  const rows = rowsOf(plan);
  const entries = browseEntries(rows, "/destination");
  const tree = browseTree(entries);
  const stats = reviewStats(rows, entries);

  // Conservation: every scanned row belongs to exactly one outcome band.
  expect(stats.organized + stats.setAside + stats.staysPut).toBe(stats.scanned);
  expect(stats.scanned).toBe(rows.length);

  // One derivation: every row occurs in exactly one entry, and the tree and
  // selected pane count the same entries at every depth — including root.
  const represented = entries.flatMap(entryRows).map((row) => row.source);
  expect(represented.sort()).toEqual(rows.map((row) => row.source).sort());
  expect(new Set(represented).size).toBe(rows.length);
  for (const node of walkTree(tree)) {
    const selected = entriesIn(entries, node.path);
    expect(selected).toHaveLength(node.count);
    const groupedCount = folderGroups(selected, node.path).reduce(
      (sum, folder) => sum + folder.entries.length,
      0,
    );
    expect(groupedCount).toBe(node.count);
  }

  const allSetEntries = duplicateSetEntries(rows, "/destination");
  const outstanding = allSetEntries.filter(
    (entry) => !entry.hasBaseline && isOutstandingState(entry.decisionState),
  );
  const queue = resolveQueue(entries);
  const staysOutstanding = entries.filter(
    (entry): entry is SetEntry =>
      entry.kind === "set" &&
      isOutstandingState(entry.decisionState) &&
      entry.folder === `_stays/${entry.decisionState}`,
  );

  // Four surfaces, one answer: summary, stays branch, queue and Execute gate.
  expect(stats.outstanding).toBe(outstanding.length);
  expect(staysOutstanding).toHaveLength(stats.outstanding);
  expect(queue).toHaveLength(stats.outstanding);
  expect(stats.undecided).toBe(
    outstanding.filter((entry) => isUndecidedState(entry.decisionState)).length,
  );
  expect(stats.proposed).toBe(
    outstanding.filter((entry) => isProposedState(entry.decisionState)).length,
  );
  const gateInputs: StageInputs = {
    rootsReady: true,
    rootsReason: null,
    scanned: true,
    planned: true,
    plannedReason: null,
    duplicateReviewReady: stats.outstanding === 0,
    duplicateReviewReason: `${stats.outstanding} outstanding`,
    blocked: false,
    blockedReason: null,
  };
  expect(readiness("execute", gateInputs).canEnter).toBe(stats.outstanding === 0);

  // No orphan and counted once: every in-run duplicate is part of the one set
  // that owns its row, even when both detections found it.
  for (const row of rows.filter((candidate) => candidate.status === "duplicate")) {
    expect(row.stack, `orphan duplicate ${row.source}`).not.toBeNull();
  }
  expect(new Set(allSetEntries.map((entry) => entry.id)).size).toBe(allSetEntries.length);

  // The wire matches only accepted decisions. Proposals deliberately produce
  // no wire entry and every outstanding set stays put as a whole.
  const actualWire = reviewedSetsFrom(rows, plan.decisions);
  const expectedWire = allSetEntries
    .filter((entry) => plan.decisions.has(entry.id))
    .map(expectedDecision)
    .filter((decision): decision is NonNullable<typeof decision> => decision !== null);
  expect(actualWire).toEqual(expectedWire);
  expect(actualWire).toHaveLength(
    allSetEntries.filter((entry) => plan.decisions.has(entry.id) && !entry.hasBaseline).length,
  );

  // A set is one entry, in the placement represented by its keeper or in the
  // one stays division that explains why no placement will happen. A keep-all
  // decision retires the set entry and restores each member as an ordinary file.
  for (const entry of allSetEntries) {
    const matchingSets = entries.filter((candidate) => candidate.key === entry.key);
    if (entry.decisionKind === "keep_all") {
      expect(matchingSets).toEqual([]);
      expect(
        entries.filter(
          (candidate) => candidate.kind === "file" && entry.rows.includes(candidate.row),
        ),
      ).toHaveLength(entry.rows.length);
      continue;
    }
    expect(matchingSets).toHaveLength(1);
    if (entry.folder.startsWith("_stays")) continue;
    expect(entry.keeper).not.toBeNull();
  }

  // Pure derivations are idempotent.
  const rowsAgain = rowsOf(plan);
  const entriesAgain = browseEntries(rowsAgain, "/destination");
  expect(rowsAgain).toEqual(rows);
  expect(entriesAgain).toEqual(entries);
  expect(reviewStats(rowsAgain, entriesAgain)).toEqual(stats);
}

describe("generated Review plans", () => {
  it("covers every shape represented by the existing hand-built fixtures", () => {
    const plans = DEVELOPMENT_SEEDS.map(generatedPlan);
    const rows = plans.flatMap(rowsOf);
    const entries = plans.flatMap((plan) => browseEntries(rowsOf(plan), "/destination"));
    const statuses = new Set(plans.flatMap((plan) => plan.result.items.map((item) => item.status)));
    const depths = new Set(
      plans.flatMap((plan) =>
        plan.result.items.map((item) =>
          item.destination === null
            ? -1
            : item.destination.replace("/destination", "").split("/").filter(Boolean).length - 1,
        ),
      ),
    );

    expect(plans.some((plan) => plan.result.items.length === 0)).toBe(true);
    expect([...statuses].sort()).toEqual([...STATUSES, "duplicate"].sort());
    expect(depths).toEqual(expect.objectContaining(new Set([-1, 0, 1, 2, 3])));
    expect(rows.some((row) => row.companionCount > 0)).toBe(true);
    expect(entries.some((entry) => entry.kind === "set" && entry.rows.length === 2)).toBe(true);
    expect(entries.some((entry) => entry.kind === "set" && entry.rows.length > 2)).toBe(true);
    expect(entries.some((entry) => entry.kind === "set" && entry.hasBaseline)).toBe(true);
    expect(entries.some((entry) => entry.kind === "set" && entry.origin === "catalog")).toBe(true);
    expect(entries.some((entry) => entry.kind === "set" && entry.origin === "plan")).toBe(true);
    const states = new Set(
      plans.flatMap((plan) =>
        duplicateSetEntries(rowsOf(plan)).map((entry) => entry.decisionState),
      ),
    );
    expect(states).toEqual(new Set(["undecided", "proposed", "decided"]));
    expect(
      plans.some((plan) =>
        [...plan.decisions.values()].some((decision) => decision.kind === "keep_all"),
      ),
    ).toBe(true);
  });

  it.each(DEVELOPMENT_SEEDS.map((seed) => [`seed ${seed}`, seed] as const))(
    "%s preserves every Review agreement",
    (_label, seed) => assertPlanInvariants(seed),
  );

  it("keeps every invariant over the 512-plan acceptance corpus", () => {
    for (const seed of ACCEPTANCE_SEEDS) {
      try {
        assertPlanInvariants(seed);
      } catch (error) {
        throw new Error(`Review invariant failed for seed ${seed}: ${String(error)}`);
      }
    }
  });
});
