/**
 * One row model for the whole Review surface.
 *
 * Review used to be four tabs over three different data sources, which is why a
 * summary tile could read "0 duplicates found" beside four duplicate groups.
 * Everything here derives from the one `PreviewResult` the dry run produced,
 * plus the duplicate stacks — so every count on the screen is the same
 * arithmetic over the same rows, and two numbers cannot disagree.
 *
 * **Status is what will happen. Flags are caveats. Reason is why.** A status
 * becomes the destination cell in plain language; a flag is a small badge that
 * says what to do about it; the reason is one sentence saying how the file came
 * to land where it lands. Nothing is two of the three.
 */

import { REVIEW_FOLDER_NAMES } from "@/lib/reviewPlan";
import {
  decisionState,
  isOutstandingState,
  isProposedState,
  type DuplicateDecision,
  type DuplicateDecisionState,
  type KeeperProposal,
} from "@/lib/duplicateDecisions";
import type { DuplicateGroup } from "@/lib/reviewWorkbench";
import type { OutcomeProvenance, PreviewItem, PreviewResult } from "@/types/api";

export type RowStatus =
  | "organize"
  | "keep_in_place"
  | "duplicate"
  | "junk"
  | "already_there"
  | "baseline"
  | "unreadable";

export type RowFlag = "name_clash" | "duplicate_pending" | "unit_member";
export type SetAsideCategory = "copy" | "junk" | "undated" | "corrupted";

/**
 * Why this file lands where it lands, as a message key and its parameters.
 *
 * A key rather than a sentence: the rows are derived in a pure module that has
 * no locale, and forty thousand pre-translated strings would have to be rebuilt
 * every time the language changes. Derived in the same pass as `status` and
 * `flags`, so it costs no request — which is the property that lets the list
 * show a reason on every row at all.
 */
export interface RowReason {
  key: string;
  params?: Record<string, string | number>;
}

export interface RowStack {
  id: string;
  kind: "exact" | "similar" | "burst";
  memberId: string;
  size: number;
  isKeeper: boolean;
  /** The file kept instead of this one, for a non-keeper. */
  keptInstead: string | null;
  hasBaseline: boolean;
  /**
   * Which detection found this set.
   *
   * There are two, and they are independent: the dry run matches each file
   * against the run's registry, and the catalog answers a separate query. A set
   * only the run found is still a set — but it is worth being able to say so
   * rather than inferring it, because the two carry different member identity
   * and only one of them survives into the next run.
   */
  origin: "catalog" | "plan";
  /** The one vocabulary every duplicate surface uses. */
  decisionState: DuplicateDecisionState;
  /** How a binding decision was made; null for an outstanding set. */
  decisionKind: DuplicateDecision["kind"] | null;
  /** The candidate a rule ranked without binding. */
  isProposedKeeper: boolean;
  proposalPolicy: import("@/services/api").KeeperPolicyId | null;
}

export interface ReviewRow {
  source: string;
  name: string;
  folder: string;
  destination: string | null;
  /** This member's own path before a duplicate decision makes it follow a keeper. */
  wouldBeDestination: string | null;
  status: RowStatus;
  flags: RowFlag[];
  sizeBytes: number;
  date: string | null;
  dateSource: string;
  category: string | null;
  tags: string[];
  unitId: string | null;
  unitPrimary: boolean;
  companionCount: number;
  /** The plan's own explanation; carried into Detail without a row-level request. */
  provenance: OutcomeProvenance | null;
  stack: RowStack | null;
  /** One sentence saying why this file lands where it lands. */
  reason: RowReason;
  /** True when no date could be extracted — drives the "No date" chip. */
  undated: boolean;
  /** The date is real but implausible; the file still sorts. */
  suspiciousDate: boolean;
  futureDate: boolean;
  /** Why it is set aside at this location; null when the run writes it normally. */
  setAsideCategory: SetAsideCategory | null;
}

export const REVIEW_FOLDERS = REVIEW_FOLDER_NAMES;

type DecisionInput = ReadonlyMap<string, DuplicateDecision | string>;

/** Accept the former keeper-id map while dependent specs migrate in order. */
function normalizeDecisions(input: DecisionInput): Map<string, DuplicateDecision> {
  return new Map(
    [...input].map(([setId, decision]) => [
      setId,
      typeof decision === "string" ? { kind: "keeper", memberId: decision } : decision,
    ]),
  );
}

// ── Building ─────────────────────────────────────────────────────────────────

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
  );
}

function dirname(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function statusOf(item: PreviewItem): RowStatus {
  switch (item.status) {
    case "junk":
      return "junk";
    case "duplicate":
      return "duplicate";
    case "already_in_destination":
      return "already_there";
    case "failed":
      return "unreadable";
    // `keep_in_place` is the deduplicate-only run mode, where a file that is
    // neither duplicate nor junk does not move at all.
    case "review_only":
    case "keep_in_place":
      return "keep_in_place";
    default:
      return "organize";
  }
}

function flagsOf(item: PreviewItem, nameCounts: Map<string, number>): RowFlag[] {
  const flags: RowFlag[] = [];
  if (item.destination !== null && (nameCounts.get(item.destination) ?? 0) > 1) {
    flags.push("name_clash");
  }
  if (item.duplicate_evaluation === "unknown") flags.push("duplicate_pending");
  if (item.unit_id && (item.companions?.length ?? 0) > 0) flags.push("unit_member");
  return flags;
}

/**
 * The date sources the backend reports, each with a sentence of its own.
 *
 * Anything outside this list is described generically rather than shown raw:
 * "metadata_source: video_metadata" is a field name, not a reason.
 */
const DATE_SOURCES = new Set([
  "exif",
  "video_metadata",
  "filesystem",
  "filename",
  "sidecar",
  "none",
]);

/**
 * Why this file lands where it lands, in one sentence.
 *
 * Ordered by what overrides what: a baseline is never touched; a set membership
 * explains both the copy that stays and the copies that do not. Only when none
 * of those apply is the question "which date decided the folder?".
 */
function reasonOf(item: PreviewItem, stack: RowStack | null): RowReason {
  if (stack?.hasBaseline === true && stack.isKeeper) return { key: "review.reason.baseline" };
  if (stack?.decisionKind === "keep_all") return { key: "review.reason.notDuplicates" };

  switch (item.status) {
    case "failed":
      return { key: "review.reason.unreadable" };
    case "junk":
      return item.quarantine_reason
        ? { key: "review.reason.junkBecause", params: { rule: item.quarantine_reason } }
        : { key: "review.reason.junk" };
    case "already_in_destination":
      return { key: "review.reason.alreadyThere" };
    case "duplicate_unknown":
      return { key: "review.reason.duplicatePending" };
    default:
      break;
  }

  if (stack !== null) {
    // A baseline decides its own set: the reference always wins, and there is
    // nothing for a person to choose.
    if (isOutstandingState(stack.decisionState) && !stack.hasBaseline) {
      return isProposedState(stack.decisionState)
        ? { key: "review.reason.duplicateProposed", params: { count: stack.size } }
        : { key: "review.reason.duplicateUndecided", params: { count: stack.size } };
    }
    if (!stack.isKeeper) {
      return stack.keptInstead === null
        ? { key: "review.reason.duplicatePlain" }
        : { key: "review.reason.duplicateCopy", params: { kept: basename(stack.keptInstead) } };
    }
    return { key: "review.reason.duplicateKeeper", params: { count: stack.size } };
  }

  if (item.status === "duplicate") return { key: "review.reason.duplicatePlain" };
  if (item.status === "keep_in_place" || item.status === "review_only") {
    return { key: "review.reason.keepInPlace" };
  }
  const recordedDate = item.provenance?.date.resolved_date ?? item.extracted_date;
  if (item.status === "unknown_date" || recordedDate === null) {
    return { key: "review.reason.noDate" };
  }
  if (item.status === "suspicious_date") return { key: "review.reason.suspiciousDate" };
  if (item.status === "future_date") return { key: "review.reason.futureDate" };

  const recordedSource = item.provenance?.date.winning_source ?? item.metadata_source;
  const source = DATE_SOURCES.has(recordedSource) ? recordedSource : "other";
  return { key: `review.reason.date.${source}`, params: { date: recordedDate } };
}

function setAsideCategoryOf(item: PreviewItem, stack: RowStack | null): SetAsideCategory | null {
  if (stack !== null && isOutstandingState(stack.decisionState) && !stack.hasBaseline) return null;
  if (stack?.decisionKind === "keep_all") {
    const own = item.would_be_destination ?? item.destination ?? "";
    if (/(^|[/\\])_junk([/\\]|$)/.test(own)) return "junk";
    if (/(^|[/\\])_undated([/\\]|$)/.test(own)) return "undated";
    if (/(^|[/\\])_corrupted([/\\]|$)/.test(own)) return "corrupted";
    return null;
  }
  if (stack?.isKeeper) {
    const own = item.would_be_destination ?? item.destination ?? "";
    if (/(^|[/\\])_junk([/\\]|$)/.test(own)) return "junk";
    if (/(^|[/\\])_undated([/\\]|$)/.test(own)) return "undated";
    if (/(^|[/\\])_corrupted([/\\]|$)/.test(own)) return "corrupted";
    return null;
  }
  if (stack !== null && !stack.isKeeper) return "copy";
  if (item.status === "duplicate") return "copy";
  if (item.status === "junk") return "junk";
  if (
    item.status === "unknown_date" ||
    item.status === "suspicious_date" ||
    item.status === "future_date"
  )
    return "undated";
  if (item.status === "failed") return "corrupted";
  return null;
}

/** A set the plan found, reduced to what the tally and the stacks both need. */
export interface PlanDuplicateSet {
  id: string;
  kind: "exact" | "similar";
  /** The kept copy first, when the run holds it, then the copies of it. */
  memberPaths: string[];
}

/**
 * Catalog groups reduced to members the current dry run can actually act on.
 *
 * The catalog covers the whole application-data library, while Review covers
 * one preview. A catalog group may therefore contain one current file and one
 * file from an earlier run. That relationship belongs in the separate
 * "outside this run" disclosure, but it is not a choice between two files on
 * this screen. Keeping those singleton fragments used to create impossible
 * "1 copy" cards that blocked Execute forever.
 *
 * Return full `DuplicateGroup` values so proposals, comparisons, rows, and the
 * live-decision reconciliation all consume the same scoped membership.
 */
export function catalogGroupsForRun(
  items: readonly PreviewItem[],
  groups: readonly DuplicateGroup[],
): DuplicateGroup[] {
  const present = new Set(items.map((item) => item.source));
  const scoped: DuplicateGroup[] = [];
  for (const group of groups) {
    const members = group.members.filter((member) => present.has(member.observed_path));
    if (members.length < 2) continue;
    const anchor = members.some((member) => member.member_id === group.anchor_member_id)
      ? group.anchor_member_id
      : (members[0]?.member_id ?? null);
    scoped.push({
      ...group,
      members,
      member_count: members.length,
      total_bytes: members.reduce((total, member) => total + member.facts.size_bytes, 0),
      anchor_member_id: anchor,
    });
  }
  return scoped;
}

/** `perceptual` is what the plan calls what the catalog calls `similar`. */
function planKind(items: readonly PreviewItem[], members: ReadonlySet<string>) {
  return items.some((item) => members.has(item.source) && item.duplicate_type === "perceptual")
    ? ("similar" as const)
    : ("exact" as const);
}

/**
 * The duplicate sets the dry run found, rebuilt from the plan alone.
 *
 * The two detections are independent. `PreviewService._preview_file` matches
 * each file against the run's `DuplicateRegistry` and, on a hit, marks it
 * `duplicate` and places it beside its keeper under `_copies/`.
 * The catalog behind `GET /api/review/groups` is a separate query, and it was
 * the only thing that ever produced a `RowStack`. So a file the run was setting
 * aside as a copy, with no catalog group covering it, reached the screen with no
 * stack: counted in no set, offered in no queue, and decidable by nothing.
 *
 * Everything needed to rebuild the set is already on the item — `duplicate_of`
 * names the copy that was kept. A set needs two members the run acts on, exactly
 * as a catalog set does: one file alone has nothing to be a duplicate of.
 *
 * Pure and derived from `items` only, so it can be computed before the catalog
 * answers without making the two derivations circular.
 */
export function planDuplicateSets(items: readonly PreviewItem[]): PlanDuplicateSet[] {
  const copiesByKeeper = new Map<string, string[]>();
  for (const item of items) {
    if (item.status !== "duplicate") continue;
    const keeper = item.duplicate_of;
    if (!keeper) continue;
    const copies = copiesByKeeper.get(keeper);
    if (copies) copies.push(item.source);
    else copiesByKeeper.set(keeper, [item.source]);
  }

  const present = new Set(items.map((item) => item.source));
  const sets: PlanDuplicateSet[] = [];
  for (const [keeper, copies] of copiesByKeeper) {
    // The kept copy belongs to its own set, but only when the run holds it too:
    // a partner outside this run is not something the user can choose between.
    const memberPaths = present.has(keeper) ? [keeper, ...copies] : copies;
    if (memberPaths.length < 2) continue;
    sets.push({
      id: `plan:${keeper}`,
      kind: planKind(items, new Set(memberPaths)),
      memberPaths,
    });
  }
  return sets;
}

/**
 * Plan-found sets as stacks, for every member the catalog has not already
 * claimed.
 *
 * The catalog wins an overlap — it is the durable identity, and it is what a
 * decision made here has to survive as. Skipping a set whose members are already
 * claimed is what keeps a file in both detections counted once.
 */
function planStacks(
  items: readonly PreviewItem[],
  claimed: ReadonlyMap<string, RowStack>,
  decisions: ReadonlyMap<string, DuplicateDecision>,
  proposals: ReadonlyMap<string, KeeperProposal>,
): Map<string, RowStack> {
  const stacks = new Map<string, RowStack>();
  for (const set of planDuplicateSets(items)) {
    const members = set.memberPaths.filter((path) => !claimed.has(path));
    if (members.length < 2) continue;
    // The plan's own keeper is the file the others are copies of, which is the
    // first member. An override replaces it; a stale one falls back rather than
    // leaving the set with no keeper at all.
    const decision = decisions.get(set.id);
    const chosen = decision?.kind === "keeper" ? decision.memberId : undefined;
    const keeper = chosen !== undefined && members.includes(chosen) ? chosen : members[0];
    const proposal = proposals.get(set.id);
    const state = decisionState(set.id, decisions, proposals);
    for (const source of members) {
      const isKeeper = source === keeper;
      stacks.set(source, {
        id: set.id,
        kind: set.kind,
        memberId: source,
        size: members.length,
        isKeeper,
        keptInstead: isKeeper ? null : keeper,
        hasBaseline: false,
        decisionState: state,
        decisionKind: decision?.kind ?? null,
        isProposedKeeper: proposal?.memberId === source,
        proposalPolicy: proposal?.policy ?? null,
        origin: "plan",
      });
    }
  }
  return stacks;
}

/**
 * Rows for every item in the plan, with stack membership folded in.
 *
 * Everything comes from `result.items` plus the stacks already fetched for the
 * screen — there is no per-row network call, because a list of 40,000 files
 * cannot afford one.
 */
export function toReviewRows(
  result: PreviewResult,
  stacks: DuplicateGroup[] = [],
  decisionInput: DecisionInput = new Map(),
  proposals: ReadonlyMap<string, KeeperProposal> = new Map(),
): ReviewRow[] {
  const decisions = normalizeDecisions(decisionInput);
  const nameCounts = new Map<string, number>();
  for (const item of result.items) {
    if (item.destination === null) continue;
    nameCounts.set(item.destination, (nameCounts.get(item.destination) ?? 0) + 1);
  }

  const stackBySource = new Map<string, RowStack>();
  for (const group of catalogGroupsForRun(result.items, stacks)) {
    // The override the user made on this screen, else the group's own anchor.
    // Previously this read a `plans` map that nothing ever populated, so the
    // anchor always won and every keeper decision repainted nothing.
    const decision = decisions.get(group.group_id);
    const requestedKeeperId =
      decision?.kind === "keeper" ? decision.memberId : group.anchor_member_id;
    const keeper =
      group.members.find((member) => member.member_id === requestedKeeperId) ?? group.members[0];
    const keeperId = keeper?.member_id ?? null;
    const hasBaseline = group.members.some((member) => member.role === "reference");
    const proposal = proposals.get(group.group_id);
    const state = decisionState(group.group_id, decisions, proposals);
    for (const member of group.members) {
      const isKeeper = member.member_id === keeperId;
      stackBySource.set(member.observed_path, {
        id: group.group_id,
        kind: group.kind,
        memberId: member.member_id,
        size: group.member_count,
        isKeeper,
        keptInstead: isKeeper ? null : (keeper?.observed_path ?? null),
        hasBaseline,
        decisionState: state,
        decisionKind: decision?.kind ?? null,
        isProposedKeeper: proposal?.memberId === member.member_id,
        proposalPolicy: proposal?.policy ?? null,
        origin: "catalog",
      });
    }
  }

  // Everything the run is setting aside that the catalog does not account for.
  // Without this the plan and the screen disagreed: files went under `_copies/`
  // while the summary said the run held no duplicate sets at all.
  for (const [source, stack] of planStacks(result.items, stackBySource, decisions, proposals)) {
    stackBySource.set(source, stack);
  }

  return result.items.map((item): ReviewRow => {
    const stack = stackBySource.get(item.source) ?? null;
    const baseline = stack?.hasBaseline === true && stack.isKeeper;
    const distinct = stack?.decisionKind === "keep_all";
    const base = distinct && item.status === "duplicate" ? "organize" : statusOf(item);
    return {
      source: item.source,
      name: basename(item.source),
      folder: dirname(item.source),
      destination: distinct ? (item.would_be_destination ?? item.destination) : item.destination,
      wouldBeDestination: item.would_be_destination ?? null,
      status: baseline ? "baseline" : base,
      flags: flagsOf(item, nameCounts),
      sizeBytes: item.file_size ?? 0,
      date: item.extracted_date,
      dateSource: item.metadata_source,
      category: item.category ?? null,
      tags: item.tags ?? [],
      unitId: item.unit_id ?? null,
      unitPrimary: item.unit_primary ?? true,
      companionCount: item.companions?.length ?? 0,
      provenance: item.provenance ?? null,
      stack,
      reason: reasonOf(item, stack),
      undated: item.status === "unknown_date" || item.extracted_date === null,
      suspiciousDate: item.status === "suspicious_date",
      futureDate: item.status === "future_date",
      setAsideCategory: setAsideCategoryOf(item, stack),
    };
  });
}

// ── Decisions on the wire ────────────────────────────────────────────────────

/**
 * The keeper decisions this run carries, in the shape `sorting/start` accepts.
 *
 * Paths, not member ids: a set the dry run found for itself has no catalog
 * member records, and the run addresses files by path either way.
 */
export function reviewedSetsFrom(
  rows: readonly ReviewRow[],
  decisionInput: DecisionInput,
): { keep: string; demote: string[]; keep_all?: boolean }[] {
  const decisions = normalizeDecisions(decisionInput);
  const bySet = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    if (row.stack === null || !decisions.has(row.stack.id)) continue;
    const members = bySet.get(row.stack.id);
    if (members) members.push(row);
    else bySet.set(row.stack.id, [row]);
  }

  const reviewed: { keep: string; demote: string[]; keep_all?: boolean }[] = [];
  for (const [setId, members] of bySet) {
    const actionable = members.filter((row) => row.status !== "baseline");
    if (actionable.length === 0) continue;
    const decision = decisions.get(setId);
    if (decision?.kind === "keep_all") {
      reviewed.push({
        keep: actionable[0].source,
        demote: actionable.slice(1).map((row) => row.source),
        keep_all: true,
      });
      continue;
    }
    const keeper = actionable.find((row) => row.stack?.isKeeper === true) ?? actionable[0];
    reviewed.push({
      keep: keeper.source,
      demote: actionable.filter((row) => row !== keeper).map((row) => row.source),
    });
  }
  return reviewed;
}

// ── Destinations ─────────────────────────────────────────────────────────────

/**
 * The folder segments a destination sits in, without the file name.
 *
 * The tree and the pane that answers a click on it derive from this one
 * function. They used not to: the tree split the path into segments while the
 * filter ran `includes()` over the whole string, so selecting `sorted/2019`
 * listed `sorted/2019-backup` as well and the node's count no longer described
 * the list beside it.
 */
export function destinationSegments(destination: string, root = ""): string[] {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const full = normalize(destination);
  const prefix = normalize(root);
  // Without the root stripped these are the machine's directory layout —
  // `Users / me / Pictures / sorted / 2019` — instead of the library the user is
  // about to get. It also put a real path segment where the review folder
  // should be, so `_duplicates/` was never recognised as one and every file
  // bound for it was counted as organized. A path outside the root is left
  // whole: that is a genuine anomaly and hiding it would be worse.
  const relative =
    prefix !== "" && (full === prefix || full.startsWith(`${prefix}/`))
      ? full.slice(prefix.length)
      : full;
  return relative.split("/").filter(Boolean).slice(0, -1);
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface SelectionActions {
  canKeepOnlyThis: boolean;
  canCompare: boolean;
  /** Why each disabled action does not apply, keyed by action. */
  reasons: Partial<Record<"keepOnlyThis" | "compare", string>>;
}

/**
 * What the selection bar may offer, and why not when it may not.
 *
 * Every disabled control carries a reason: a button that is grey for unstated
 * reasons is a button people click twice and then distrust.
 */
export function selectionActions(selected: ReviewRow[]): SelectionActions {
  const reasons: SelectionActions["reasons"] = {};
  const canKeepOnlyThis = selected.length === 1 && selected[0]?.stack !== null;
  const canCompare = selected.length === 2;
  if (!canKeepOnlyThis) {
    reasons.keepOnlyThis =
      selected.length === 1
        ? "This file is not one of a set of copies."
        : "Select exactly one copy.";
  }
  if (!canCompare) {
    reasons.compare = "Select exactly two files to compare.";
  }
  return { canKeepOnlyThis, canCompare, reasons };
}

/**
 * The two rows a comparison is between.
 *
 * Exactly two, always the two chosen. The previous implementation picked an
 * arbitrary partner when a stack held three or more copies, so the screen
 * compared against a file the user had not asked about.
 */
export function comparePair(selected: ReviewRow[]): [ReviewRow, ReviewRow] | null {
  return selected.length === 2 ? [selected[0], selected[1]] : null;
}
