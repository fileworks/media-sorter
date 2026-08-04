/**
 * One row model for the whole Review surface.
 *
 * Review used to be four tabs over three different data sources, which is why a
 * summary tile could read "0 duplicates found" beside four duplicate groups.
 * Everything here derives from the one `PreviewResult` the dry run produced,
 * plus the duplicate stacks — so every count on the screen is the same
 * arithmetic over the same rows, and two numbers cannot disagree.
 *
 * **Status is what will happen. Flags are caveats.** A status becomes the
 * destination cell in plain language; a flag is a small badge that says what to
 * do about it. Nothing is both.
 */

import { REVIEW_FOLDER_NAMES, type TreeNode } from "@/lib/reviewPlan";
import type { DuplicateGroup, GroupPlan } from "@/lib/reviewWorkbench";
import type { PreviewItem, PreviewResult } from "@/types/api";

export type RowStatus =
  | "organize"
  | "keep_in_place"
  | "duplicate"
  | "junk"
  | "already_there"
  | "baseline"
  | "unreadable"
  | "excluded";

export type RowFlag = "name_clash" | "duplicate_pending" | "unit_member";

export interface RowStack {
  id: string;
  kind: "exact" | "similar" | "burst";
  memberId: string;
  size: number;
  isKeeper: boolean;
  /** The file kept instead of this one, for a non-keeper. */
  keptInstead: string | null;
  hasBaseline: boolean;
}

export interface ReviewRow {
  source: string;
  name: string;
  folder: string;
  destination: string | null;
  status: RowStatus;
  flags: RowFlag[];
  sizeBytes: number;
  width: number | null;
  height: number | null;
  date: string | null;
  dateSource: string;
  category: string | null;
  tags: string[];
  unitId: string | null;
  unitPrimary: boolean;
  companionCount: number;
  stack: RowStack | null;
  excluded: boolean;
  /** True when no date could be extracted — drives the "No date" chip. */
  undated: boolean;
  /** The date is real but implausible; the file still sorts. */
  suspiciousDate: boolean;
  futureDate: boolean;
}

export const REVIEW_FOLDERS = REVIEW_FOLDER_NAMES;

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
 * Rows for every item in the plan, with stack membership folded in.
 *
 * Everything comes from `result.items` plus the stacks already fetched for the
 * screen — there is no per-row network call, because a list of 40,000 files
 * cannot afford one.
 */
export function toReviewRows(
  result: PreviewResult,
  stacks: DuplicateGroup[] = [],
  plans: Record<string, GroupPlan | undefined> = {},
  excluded: ReadonlySet<string> = new Set(),
): ReviewRow[] {
  const nameCounts = new Map<string, number>();
  for (const item of result.items) {
    if (item.destination === null) continue;
    nameCounts.set(item.destination, (nameCounts.get(item.destination) ?? 0) + 1);
  }

  const stackBySource = new Map<string, RowStack>();
  for (const group of stacks) {
    const plan = plans[group.group_id];
    const keeperId = plan?.keeper_member_id ?? group.anchor_member_id;
    const hasBaseline = group.members.some((member) => member.role === "reference");
    const keeper = group.members.find((member) => member.member_id === keeperId);
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
      });
    }
  }

  return result.items.map((item): ReviewRow => {
    const stack = stackBySource.get(item.source) ?? null;
    const baseline = stack?.hasBaseline === true && stack.isKeeper;
    const isExcluded = excluded.has(item.source);
    const base = statusOf(item);
    return {
      source: item.source,
      name: basename(item.source),
      folder: dirname(item.source),
      destination: item.destination,
      status: isExcluded ? "excluded" : baseline ? "baseline" : base,
      flags: flagsOf(item, nameCounts),
      sizeBytes: item.file_size ?? 0,
      width: null,
      height: null,
      date: item.extracted_date,
      dateSource: item.metadata_source,
      category: item.category ?? null,
      tags: item.tags ?? [],
      unitId: item.unit_id ?? null,
      unitPrimary: item.unit_primary ?? true,
      companionCount: item.companions?.length ?? 0,
      stack,
      excluded: isExcluded,
      undated: item.status === "unknown_date" || item.extracted_date === null,
      suspiciousDate: item.status === "suspicious_date",
      futureDate: item.status === "future_date",
    };
  });
}

// ── Stacks ───────────────────────────────────────────────────────────────────

export interface Stack {
  id: string;
  kind: RowStack["kind"];
  rows: ReviewRow[];
  keeper: ReviewRow | null;
  hasBaseline: boolean;
  /**
   * The stack's own keeper was excluded and the next-best copy stands in its
   * place. Excluding a keeper is allowed — it is how "none of these, keep the
   * other one" is expressed — but a stack that silently kept nothing would
   * quarantine every copy it has.
   */
  keeperPromoted: boolean;
}

/**
 * Group rows into stacks, preserving order, with loose rows kept in place.
 *
 * Returns a flat sequence so the list renders one thing, not two interleaved
 * ones: a stack header followed by its members, or a single row.
 */
export function groupIntoStacks(rows: ReviewRow[]): Array<Stack | ReviewRow> {
  const out: Array<Stack | ReviewRow> = [];
  const byId = new Map<string, Stack>();
  for (const row of rows) {
    if (row.stack === null) {
      out.push(row);
      continue;
    }
    let stack = byId.get(row.stack.id);
    if (stack === undefined) {
      stack = {
        id: row.stack.id,
        kind: row.stack.kind,
        rows: [],
        keeper: null,
        hasBaseline: row.stack.hasBaseline,
        keeperPromoted: false,
      };
      byId.set(row.stack.id, stack);
      out.push(stack);
    }
    stack.rows.push(row);
    if (row.stack.isKeeper) stack.keeper = row;
  }

  // Excluding the keeper promotes the next copy the run may still act on. A
  // baseline is never excludable, so it can never be the one displaced.
  for (const stack of byId.values()) {
    if (stack.keeper === null || !stack.keeper.excluded) continue;
    const replacement = stack.rows.find((row) => !row.excluded && row.status !== "baseline");
    stack.keeper = replacement ?? null;
    stack.keeperPromoted = replacement !== undefined;
  }
  return out;
}

export function isStack(entry: Stack | ReviewRow): entry is Stack {
  return (entry as Stack).rows !== undefined;
}

// ── Filtering ────────────────────────────────────────────────────────────────

export type FilterKey =
  | "all"
  | "organize"
  | "duplicates"
  | "junk"
  | "already_there"
  | "unreadable"
  | "no_date"
  | "suspicious_date"
  | "future_date"
  | "excluded";

export const FILTER_KEYS: readonly FilterKey[] = [
  "all",
  "organize",
  "duplicates",
  "junk",
  "already_there",
  "unreadable",
  "no_date",
  "suspicious_date",
  "future_date",
  "excluded",
] as const;

function matchesFilter(row: ReviewRow, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "organize":
      return row.status === "organize" || row.status === "keep_in_place";
    case "duplicates":
      return row.status === "duplicate" || row.stack !== null;
    case "junk":
      return row.status === "junk";
    case "already_there":
      return row.status === "already_there";
    case "unreadable":
      return row.status === "unreadable";
    case "no_date":
      return row.undated;
    case "suspicious_date":
      return row.suspiciousDate;
    case "future_date":
      return row.futureDate;
    case "excluded":
      return row.excluded;
  }
}

/**
 * The folder segments a destination sits in, without the file name.
 *
 * Both the tree and the filter that answers a click on it derive from this one
 * function. They used not to: the tree split the path into segments while the
 * filter ran `includes()` over the whole string, so selecting `sorted/2019`
 * listed `sorted/2019-backup` as well and the node's count no longer described
 * the list beside it.
 */
export function destinationSegments(destination: string): string[] {
  return destination.replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1);
}

function inTreeFolder(destination: string | null, treePath: string): boolean {
  if (destination === null) return false;
  const folder = destinationSegments(destination).join("/");
  return folder === treePath || folder.startsWith(`${treePath}/`);
}

export interface FilterInput {
  filter: FilterKey;
  search: string;
  /** A destination-tree path prefix, or null for the whole plan. */
  treePath: string | null;
}

/** Tree, chip and search compose with AND. The visible set is their product. */
export function applyFilters(rows: ReviewRow[], input: FilterInput): ReviewRow[] {
  const needle = input.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesFilter(row, input.filter)) return false;
    if (input.treePath !== null && !inTreeFolder(row.destination, input.treePath)) return false;
    if (needle !== "") {
      const haystack = `${row.name}\n${row.folder}\n${row.destination ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export type RowCounts = Record<FilterKey, number>;

/** Every chip's number, from one pass over the same rows the list draws. */
export function rowCounts(rows: ReviewRow[]): RowCounts {
  const counts = Object.fromEntries(FILTER_KEYS.map((key) => [key, 0])) as RowCounts;
  for (const row of rows) {
    for (const key of FILTER_KEYS) {
      if (matchesFilter(row, key)) counts[key] += 1;
    }
  }
  return counts;
}

// ── Destination tree ─────────────────────────────────────────────────────────

/**
 * The folder tree the plan would produce, counted from the rows themselves.
 *
 * Built from the same rows the list filters, so clicking a folder and reading
 * its count can never disagree with what the list then shows.
 */
export function treeFromRows(rows: ReviewRow[], rootName = "destination"): TreeNode {
  const root: TreeNode = {
    name: rootName,
    path: "",
    count: 0,
    isReview: false,
    isNew: false,
    children: [],
  };
  for (const row of rows) {
    if (row.destination === null) continue;
    const segments = destinationSegments(row.destination);
    root.count += 1;
    let node = root;
    let path = "";
    for (const segment of segments) {
      path = path === "" ? segment : `${path}/${segment}`;
      let child = node.children.find((candidate) => candidate.name === segment);
      if (child === undefined) {
        child = {
          name: segment,
          path,
          count: 0,
          isReview: (REVIEW_FOLDERS as readonly string[]).includes(segment),
          isNew: false,
          children: [],
        };
        node.children.push(child);
      }
      child.count += 1;
      node = child;
    }
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

// ── Exclusion ────────────────────────────────────────────────────────────────

/**
 * Expand an exclusion to every member of the same media unit.
 *
 * Excluding the JPEG of a RAW+JPEG pair while the RAW still moves would split
 * the pair across two folders, so a companion always drags its unit with it.
 */
export function expandExclusion(rows: ReviewRow[], sources: Iterable<string>): Set<string> {
  const requested = new Set(sources);
  const units = new Set<string>();
  for (const row of rows) {
    if (row.unitId !== null && requested.has(row.source)) units.add(row.unitId);
  }
  const expanded = new Set(requested);
  for (const row of rows) {
    if (row.unitId !== null && units.has(row.unitId)) expanded.add(row.source);
  }
  return expanded;
}

/**
 * The exclusions a fresh plan starts with.
 *
 * A file nobody can read, and a file with no date, are the two cases where
 * acting is more likely to be wrong than right — so they start excluded and the
 * user opts them back in, rather than discovering afterwards where they went.
 */
export function seedExclusions(rows: ReviewRow[]): Set<string> {
  return expandExclusion(
    rows,
    rows.filter((row) => row.status === "unreadable" || row.undated).map((row) => row.source),
  );
}

/** Drop exclusions whose file is no longer in the plan, and say how many went. */
export function reconcileExclusions(
  rows: ReviewRow[],
  excluded: ReadonlySet<string>,
): { kept: Set<string>; dropped: number } {
  const present = new Set(rows.map((row) => row.source));
  const kept = new Set<string>();
  let dropped = 0;
  for (const source of excluded) {
    if (present.has(source)) kept.add(source);
    else dropped += 1;
  }
  return { kept, dropped };
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface SelectionActions {
  canExclude: boolean;
  canInclude: boolean;
  canKeepOnlyThis: boolean;
  canCompare: boolean;
  /** Why each disabled action does not apply, keyed by action. */
  reasons: Partial<Record<"exclude" | "include" | "keepOnlyThis" | "compare", string>>;
}

/**
 * What the selection bar may offer, and why not when it may not.
 *
 * Every disabled control carries a reason: a button that is grey for unstated
 * reasons is a button people click twice and then distrust.
 */
export function selectionActions(selected: ReviewRow[]): SelectionActions {
  const reasons: SelectionActions["reasons"] = {};
  const actionable = selected.filter((row) => row.status !== "baseline");
  const canExclude = actionable.some((row) => !row.excluded);
  const canInclude = actionable.some((row) => row.excluded);
  const canKeepOnlyThis = selected.length === 1 && selected[0]?.stack !== null;
  const canCompare = selected.length === 2;

  if (!canExclude) {
    reasons.exclude =
      selected.length === 0
        ? "Select a file first."
        : actionable.length === 0
          ? "Baseline files are compared against, never changed."
          : "Everything selected is already excluded.";
  }
  if (!canInclude) {
    reasons.include =
      selected.length === 0 ? "Select a file first." : "Nothing selected is excluded.";
  }
  if (!canKeepOnlyThis) {
    reasons.keepOnlyThis =
      selected.length === 1
        ? "This file is not one of a set of copies."
        : "Select exactly one copy.";
  }
  if (!canCompare) {
    reasons.compare = "Select exactly two files to compare.";
  }
  return { canExclude, canInclude, canKeepOnlyThis, canCompare, reasons };
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
