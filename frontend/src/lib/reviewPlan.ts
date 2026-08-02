/**
 * Everything the Review screen needs to know, derived from the dry run.
 *
 * Pure on purpose: the plan is the only thing standing between a user and
 * eleven thousand file operations, so what it claims has to be testable without
 * a DOM. Nothing here fetches, and nothing here guesses — a figure the plan does
 * not contain is absent rather than approximated.
 */

import type { Config, PreviewItem, PreviewResult } from "@/types/api";

// ── Headline figures ─────────────────────────────────────────────────────────

export interface PlanTotals {
  scanned: number;
  ready: number;
  duplicates: number;
  duplicatesResolved: number;
  duplicatesUnresolved: number;
  junk: number;
  warnings: number;
  /** Share of the scan each band occupies, as percentages summing to ≤ 100. */
  share: { ready: number; duplicates: number; junk: number };
}

export function planTotals(result: PreviewResult, warningCount: number): PlanTotals {
  const stats = result.stats;
  const scanned = stats.total;
  const duplicates = stats.will_skip_duplicate + (stats.duplicate_unknown ?? 0);
  const junk = stats.will_quarantine_junk;
  const ready = stats.will_sort;
  const unresolved = result.impact.unresolved_count;

  const pct = (value: number) => (scanned > 0 ? (value / scanned) * 100 : 0);

  return {
    scanned,
    ready,
    duplicates,
    duplicatesResolved: Math.max(0, duplicates - unresolved),
    duplicatesUnresolved: unresolved,
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
  const collisionFiles = [...collisions.values()].reduce(
    (sum, group) => sum + group.length - 1,
    0,
  );
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

const REVIEW_FOLDERS = new Set(["_duplicates", "_junk", "_unknown_date", "_future_date", "_failed"]);

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

export function tabCounts(result: PreviewResult, warnings: PlanWarning[]): TabCounts {
  return {
    duplicates: result.stats.will_skip_duplicate + (result.stats.duplicate_unknown ?? 0),
    junk: result.stats.will_quarantine_junk,
    changes: result.stats.will_sort,
    warnings: warningTotal(warnings),
  };
}
