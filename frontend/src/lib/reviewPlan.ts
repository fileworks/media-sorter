/**
 * Everything the Review screen needs to know, derived from the dry run.
 *
 * Pure on purpose: the plan is the only thing standing between a user and
 * eleven thousand file operations, so what it claims has to be testable without
 * a DOM. Nothing here fetches, and nothing here guesses — a figure the plan does
 * not contain is absent rather than approximated.
 */

import type { Config, PreviewItem, PreviewResult } from "@/types/api";
import { isWithin } from "@/lib/sourcesStage";

// ── Headline figures ─────────────────────────────────────────────────────────

export interface PlanTotals {
  scanned: number;
  ready: number;
  /** Copies the run would set aside — every member of a set but the one kept. */
  duplicates: number;
  /** Sets those copies belong to. Reported beside the copies, never instead of them. */
  duplicateSets: number;
  duplicatesResolved: number;
  duplicatesUnresolved: number;
  /** Sets this run does not act on, stated separately rather than folded in. */
  duplicatesOutOfScope: number;
  junk: number;
  warnings: number;
  /** Share of the scan each band occupies, as percentages summing to ≤ 100. */
  share: { ready: number; duplicates: number; junk: number };
}

/**
 * Duplicates as the one number every surface reports.
 *
 * Three places used to answer this question and gave three answers, none of
 * which was what the run would do. This derivation fixes all three properties
 * that were wrong:
 *
 * - **Sets and copies, not members.** "How many duplicate sets are there" and
 *   "how many copies would be set aside" are the two questions people ask; the
 *   sum of group sizes answers neither. Five sets of three is `5 sets · 10
 *   copies`, never `15`.
 * - **Run-scoped.** A set counts when at least two of its members are files
 *   this run acts on. That is what makes the figure checkable by counting the
 *   result — the reported symptom was 14 against a screen showing 5.
 * - **Counted once.** A file in both an exact and a similar set is one file.
 *   The groups arrive from three independent queries, flat-mapped, so without
 *   this the overlap is counted twice.
 */
export interface DuplicateTally {
  /** Sets with at least two members this run acts on. */
  sets: number;
  /** Copies inside those sets that the run would set aside — every member but the keeper. */
  copies: number;
  /** Sets whose keeper the user has chosen. */
  resolved: number;
  /** Sets still waiting on a decision, which the run will skip. */
  unresolved: number;
  /** Sets the run does not touch at all, stated separately rather than hidden. */
  outOfScope: number;
}

/** One duplicate set, reduced to what the tally needs. */
export interface TallyGroup {
  id: string;
  /** Strongest first: an overlap is attributed to the stronger evidence. */
  kind: "exact" | "similar" | "burst";
  memberPaths: readonly string[];
  decided: boolean;
}

const KIND_STRENGTH: Record<TallyGroup["kind"], number> = { exact: 0, similar: 1, burst: 2 };

/**
 * The single duplicate derivation. Every surface reads this and only this.
 *
 * *inScope* is the set of source paths the run acts on — `result.items`. A set
 * needs two of its members in there before it is a duplicate *of this run*:
 * one member alone has nothing to be a duplicate of.
 */
export function duplicateTally(
  groups: readonly TallyGroup[],
  inScope: ReadonlySet<string>,
  excludedRoots: readonly string[] = [],
): DuplicateTally {
  const ordered = [...groups].sort((a, b) => KIND_STRENGTH[a.kind] - KIND_STRENGTH[b.kind]);
  const claimed = new Set<string>();
  let sets = 0;
  let copies = 0;
  let resolved = 0;
  let outOfScope = 0;

  for (const group of ordered) {
    // A member already counted under stronger evidence is not counted again,
    // but it still belongs to this set — it just cannot add a second copy.
    const present = group.memberPaths.filter((path) => inScope.has(path));
    if (present.length < 2) {
      const omittedByScope = group.memberPaths.some(
        (path) => !inScope.has(path) && excludedRoots.some((root) => isWithin(path, root)),
      );
      if (omittedByScope) continue;
      outOfScope += 1;
      continue;
    }
    const fresh = present.filter((path) => !claimed.has(path));
    if (fresh.length < 2) continue;
    for (const path of fresh) claimed.add(path);
    sets += 1;
    // Every member but the one that stays: that is what "set aside" means.
    copies += fresh.length - 1;
    if (group.decided) resolved += 1;
  }

  return { sets, copies, resolved, unresolved: sets - resolved, outOfScope };
}

export function planTotals(
  result: PreviewResult,
  warningCount: number,
  // The one derivation, from `duplicateTally`. The dry run counts copies it
  // would skip and the catalog counts groups it holds; those are different
  // numbers, and on a library already in its destination the first is often 0
  // against a screen full of groups. Every surface now reads the same tally, so
  // there is nothing left to disagree.
  tally?: DuplicateTally | null,
): PlanTotals {
  const stats = result.stats;
  const scanned = stats.total;
  const planDuplicates = stats.will_skip_duplicate + (stats.duplicate_unknown ?? 0);
  const duplicates = tally ? tally.copies : planDuplicates;
  const unresolved = tally ? tally.unresolved : result.impact.unresolved_count;
  const resolved = tally ? tally.resolved : Math.max(0, planDuplicates - unresolved);
  const junk = stats.will_quarantine_junk;
  const ready = stats.will_sort;

  const pct = (value: number) => (scanned > 0 ? (value / scanned) * 100 : 0);

  return {
    scanned,
    ready,
    duplicates,
    duplicateSets: tally ? tally.sets : 0,
    duplicatesResolved: resolved,
    duplicatesUnresolved: unresolved,
    duplicatesOutOfScope: tally ? tally.outOfScope : 0,
    junk,
    warnings: warningCount,
    share: { ready: pct(ready), duplicates: pct(duplicates), junk: pct(junk) },
  };
}

// ── Warnings ─────────────────────────────────────────────────────────────────

export type WarningId =
  | "name_collision"
  | "no_date"
  | "fallback_date"
  | "suspicious_date"
  | "future_date"
  | "unreadable"
  | "deferred_duplicate";

export interface PlanWarning {
  id: WarningId;
  count: number;
  severity: "warning" | "error";
  /** The statuses whose items this warning is about, for "show files". */
  statuses: PreviewItem["status"][];
}

/**
 * Two files that would land on the same name.
 *
 * Computed here rather than asked of the backend because the plan already
 * carries every destination path: the answer is a `Map`, and a round trip to
 * recompute what is already on the client would be slower and no more correct.
 * Reference and skipped items are excluded — they are not being written.
 */
export function nameCollisions(items: PreviewItem[]): Map<string, PreviewItem[]> {
  const byDestination = new Map<string, PreviewItem[]>();
  for (const item of items) {
    if (!item.destination) continue;
    if (item.status !== "sort") continue;
    const existing = byDestination.get(item.destination);
    if (existing) existing.push(item);
    else byDestination.set(item.destination, [item]);
  }
  for (const [destination, group] of byDestination) {
    if (group.length < 2) byDestination.delete(destination);
  }
  return byDestination;
}

const STATUS_COUNT = (items: PreviewItem[], status: PreviewItem["status"]) =>
  items.filter((item) => item.status === status).length;

/**
 * Everything about this plan that deserves a second look, most severe first.
 *
 * A warning is only listed when it has a non-zero count: a list of "0 problems"
 * rows trains people to stop reading the list.
 */
export function planWarnings(result: PreviewResult): PlanWarning[] {
  const items = result.items;
  const collisions = nameCollisions(items);
  const collisionFiles = [...collisions.values()].reduce((sum, group) => sum + group.length - 1, 0);
  const fallbackDated = items.filter(
    (item) => item.status === "sort" && item.metadata_source === "filesystem",
  ).length;

  const candidates: PlanWarning[] = [
    {
      id: "unreadable",
      count: STATUS_COUNT(items, "failed"),
      severity: "error",
      statuses: ["failed"],
    },
    {
      id: "name_collision",
      count: collisionFiles,
      severity: "warning",
      statuses: ["sort"],
    },
    {
      id: "no_date",
      count: STATUS_COUNT(items, "unknown_date"),
      severity: "warning",
      statuses: ["unknown_date"],
    },
    {
      id: "suspicious_date",
      count: STATUS_COUNT(items, "suspicious_date"),
      severity: "warning",
      statuses: ["suspicious_date"],
    },
    {
      id: "future_date",
      count: STATUS_COUNT(items, "future_date"),
      severity: "warning",
      statuses: ["future_date"],
    },
    {
      id: "deferred_duplicate",
      count: STATUS_COUNT(items, "duplicate_unknown"),
      severity: "warning",
      statuses: ["duplicate_unknown"],
    },
    {
      id: "fallback_date",
      count: fallbackDated,
      severity: "warning",
      statuses: ["sort"],
    },
  ];

  return candidates
    .filter((warning) => warning.count > 0)
    .sort((a, b) =>
      a.severity === b.severity ? b.count - a.count : a.severity === "error" ? -1 : 1,
    );
}

export function warningTotal(warnings: PlanWarning[]): number {
  return warnings.reduce((sum, warning) => sum + warning.count, 0);
}

// ── Destination tree ─────────────────────────────────────────────────────────

export interface TreeNode {
  /** Full path from the destination root, "/"-joined. Unique per node. */
  path: string;
  name: string;
  /** Files landing anywhere at or below this node. */
  count: number;
  children: TreeNode[];
  /** True when nothing in the destination has this folder yet. */
  isNew: boolean;
  /** Review folders read differently from date folders and are marked. */
  isReview: boolean;
}

/**
 * The folders a run may create for files a person has to look at.
 *
 * Defined once and exported, because this set was wrong in a way nothing
 * caught. It contains both the current names and read-only legacy names: old
 * destinations remain understandable, while new runs only create the current
 * set. `reviewFolders.test.ts` pins both halves to the backend declarations.
 */
export const REVIEW_FOLDER_NAMES = [
  "_undated",
  "_corrupted",
  "_junk",
  "_copies",
  // Retired names are recognised but never proposed for a new run.
  "_unknown_dates",
  "_future_dates",
  "_duplicates",
  "_failed",
  "_already_in_destination",
] as const;

/** Folders a current run may write, including contextual copy leaves. */
export const CURRENT_REVIEW_FOLDER_NAMES = ["_undated", "_corrupted", "_junk", "_copies"] as const;

const REVIEW_FOLDERS = new Set<string>(REVIEW_FOLDER_NAMES);

/** Normalise separators and drop a trailing one, so prefixes compare cleanly. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The folder segments a file lands in, relative to the destination root.
 *
 * The plan reports absolute destinations. Rendering those verbatim turns the
 * tree into the machine's directory layout — `sorted / private / tmp / …` —
 * instead of the library the user is about to get, so the root prefix is
 * stripped here. A path that is not under the root is left whole rather than
 * mangled: it is a real anomaly and hiding it would be worse than showing it.
 */
function folderSegments(destination: string, root: string): string[] {
  const normalized = normalizePath(destination);
  const prefix = normalizePath(root);
  const relative =
    prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))
      ? normalized.slice(prefix.length)
      : normalized;
  const parts = relative.split("/").filter(Boolean);
  return parts.slice(0, -1);
}

/**
 * The folder tree this plan would produce, with a count on every node.
 *
 * Built from the plan's own destination paths rather than from the filesystem:
 * the point of the panel is to show what *would* exist, and reading what
 * currently exists would answer a different question.
 *
 * `rootPath` is the configured destination directory, used to make the plan's
 * absolute paths relative. `existingFolders` — the relative folders already
 * present in the destination — is what decides the "new" badge; without it
 * every folder is reported as new, which is the honest default for a
 * destination nobody has indexed.
 */
export function destinationTree(
  items: PreviewItem[],
  rootName: string,
  options: { rootPath?: string; existingFolders?: ReadonlySet<string> } = {},
): TreeNode {
  const { rootPath = "", existingFolders = new Set<string>() } = options;
  const root: TreeNode = {
    path: "",
    name: rootName,
    count: 0,
    children: [],
    isNew: false,
    isReview: false,
  };
  const index = new Map<string, TreeNode>([["", root]]);

  for (const item of items) {
    if (!item.destination) continue;
    const segments = folderSegments(item.destination, rootPath);
    root.count += 1;
    let parent = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = index.get(prefix);
      if (!node) {
        node = {
          path: prefix,
          name: segment,
          count: 0,
          children: [],
          isNew: !existingFolders.has(prefix),
          isReview: REVIEW_FOLDERS.has(segment),
        };
        index.set(prefix, node);
        parent.children.push(node);
      }
      node.count += 1;
      parent = node;
    }
  }

  // Review folders sort last; everything else alphabetically, which for date
  // folders is also chronologically.
  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) =>
      a.isReview === b.isReview ? a.name.localeCompare(b.name) : a.isReview ? 1 : -1,
    );
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/** The destination folder's own display name, from the configured path. */
export function destinationRootName(config: Config | undefined): string {
  const path = config?.target_directory ?? "";
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "Destination";
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export interface TabCounts {
  duplicates: number;
  junk: number;
  changes: number;
  warnings: number;
}

export function tabCounts(
  result: PreviewResult,
  warnings: PlanWarning[],
  tally?: DuplicateTally | null,
): TabCounts {
  return {
    // Same derivation as `planTotals`: the badge and the tile cannot disagree
    // when neither of them does its own arithmetic.
    duplicates:
      tally?.copies ?? result.stats.will_skip_duplicate + (result.stats.duplicate_unknown ?? 0),
    junk: result.stats.will_quarantine_junk,
    changes: result.stats.will_sort,
    warnings: warningTotal(warnings),
  };
}
