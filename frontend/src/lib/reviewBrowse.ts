/**
 * What Browse renders: a folder structure, and the files that land in each.
 *
 * Two ideas live here, both of which the flat list could not express.
 *
 * **A duplicate set sits where its keeper sits.** Rendering the set anywhere
 * else would break the folder's count — the count and the contents beneath it
 * have to be the same arithmetic or neither is trustworthy. So a set is one
 * entry, in the keeper's folder, and each copy states its own destination.
 *
 * **"Stays where it is" is a branch, not a badge.** Undecided sets, baselines,
 * and files already at the destination are different reasons for the same
 * outcome — nothing happens. They used to be
 * invisible or badge-level detail, which is how a run could skip a set nobody
 * knew was undecided. As a branch they are countable, navigable, and explained
 * once per division rather than once per row.
 *
 * Pure, and derived from the same rows the list draws, so a count here can never
 * disagree with what selecting the folder then shows.
 */

import { destinationSegments, type ReviewRow } from "@/lib/reviewRows";
import { REVIEW_FOLDER_NAMES, type TreeNode } from "@/lib/reviewPlan";
import { isOutstandingState, isProposedState, isUndecidedState } from "@/lib/duplicateDecisions";

/** The synthetic branch holding everything the run will not place. */
export const STAYS_PATH = "_stays";

/** The folders a person has to look at. Declared here because both the entry
 *  builder and the tree below it read them, and the builder comes first. */
const REVIEW_FOLDERS: readonly string[] = REVIEW_FOLDER_NAMES;

export type StaysDivision = "undecided" | "proposed" | "baseline" | "already_there";

export const STAYS_DIVISIONS: readonly StaysDivision[] = [
  "undecided",
  "proposed",
  "baseline",
  "already_there",
] as const;

/**
 * Which division of "stays where it is" a row belongs to, if any.
 *
 * Order is precedence: immutable baselines, destination matches, then an
 * undecided set the run must wait on.
 */
export function staysDivisionOf(row: ReviewRow): StaysDivision | null {
  if (row.status === "baseline") return "baseline";
  if (row.status === "already_there") return "already_there";
  // A set nobody has decided is skipped whole — including its would-be keeper.
  if (row.stack !== null && isOutstandingState(row.stack.decisionState) && !row.stack.hasBaseline) {
    return isProposedState(row.stack.decisionState) ? "proposed" : "undecided";
  }
  return null;
}

// ── Entries ──────────────────────────────────────────────────────────────────

export interface FileEntry {
  kind: "file";
  key: string;
  row: ReviewRow;
  /** The folder this entry is listed under: a date path, or under `_stays`. */
  folder: string;
}

export interface SetEntry {
  kind: "set";
  key: string;
  id: string;
  setKind: "exact" | "similar" | "burst";
  /**
   * Which detection found it. A set the dry run found for itself has no
   * catalog member records behind it, so no keeper rule can rank its copies —
   * which the queue has to say rather than silently skip.
   */
  origin: "catalog" | "plan";
  rows: ReviewRow[];
  keeper: ReviewRow | null;
  hasBaseline: boolean;
  decisionState: import("@/lib/duplicateDecisions").DuplicateDecisionState;
  decisionKind: import("@/lib/duplicateDecisions").DuplicateDecision["kind"] | null;
  proposedKeeper: ReviewRow | null;
  proposalPolicy: import("@/services/api").KeeperPolicyId | null;
  folder: string;
}

export type BrowseEntry = FileEntry | SetEntry;

function folderOf(row: ReviewRow, root: string): string {
  return row.destination === null ? "" : destinationSegments(row.destination, root).join("/");
}

/** Whether a destination path passes through one of the review folders. */
function isReviewFolder(folder: string): boolean {
  return folder.split("/").some((segment) => REVIEW_FOLDERS.includes(segment));
}

/**
 * Where a set's kept copy actually lands.
 *
 * Preview records both the current outcome and every copy's own would-be path.
 * A promoted keeper uses that own path, which is essential when two identical
 * files have different fallback dates or source-relative folders. Legacy plans
 * without that field fall back to the old placed-member inference.
 */
function placementFolder(entry: SetEntry, keeper: ReviewRow, root: string): string {
  if (keeper.wouldBeDestination !== null) {
    return destinationSegments(keeper.wouldBeDestination, root).join("/");
  }
  const own = folderOf(keeper, root);
  if (own !== "" && !isReviewFolder(own)) return own;
  const placed = entry.rows.find((row) => {
    const folder = folderOf(row, root);
    return folder !== "" && !isReviewFolder(folder);
  });
  return placed === undefined ? own : folderOf(placed, root);
}

function staysFolder(division: StaysDivision): string {
  return `${STAYS_PATH}/${division}`;
}

/**
 * One entry per placed file and one per duplicate set, each with its folder.
 *
 * A set's folder is its keeper's — that is the whole reason the entry exists
 * rather than four rows scattered between a keeper folder and a root quarantine.
 * A set the run will not place at all goes to the undecided division, whole.
 */
export function duplicateSetEntries(rows: readonly ReviewRow[], root = ""): SetEntry[] {
  const entries: SetEntry[] = [];
  const setIndex = new Map<string, SetEntry>();

  for (const row of rows) {
    if (row.stack === null) continue;

    let entry = setIndex.get(row.stack.id);
    if (entry === undefined) {
      entry = {
        kind: "set",
        key: `set:${row.stack.id}`,
        id: row.stack.id,
        setKind: row.stack.kind,
        origin: row.stack.origin,
        rows: [],
        keeper: null,
        hasBaseline: row.stack.hasBaseline,
        decisionState: row.stack.decisionState,
        decisionKind: row.stack.decisionKind,
        proposedKeeper: null,
        proposalPolicy: row.stack.proposalPolicy,
        folder: "",
      };
      setIndex.set(row.stack.id, entry);
      entries.push(entry);
    }
    entry.rows.push(row);
    if (row.stack.isKeeper) entry.keeper = row;
    if (row.stack.isProposedKeeper) entry.proposedKeeper = row;
  }

  for (const entry of setIndex.values()) {
    if (entry.keeper === null) {
      const replacement = entry.rows.find((row) => row.status !== "baseline");
      entry.keeper = replacement ?? null;
    }
    const keeper = entry.keeper;
    const keeperDivision = keeper === null ? "baseline" : staysDivisionOf(keeper);
    // Undecided outranks the keeper's own division: the run skips the whole set
    // regardless of what the copy it would have kept looks like.
    if (isOutstandingState(entry.decisionState) && !entry.hasBaseline) {
      entry.folder = staysFolder(isProposedState(entry.decisionState) ? "proposed" : "undecided");
    } else if (keeper === null || keeperDivision !== null) {
      entry.folder = staysFolder(keeperDivision ?? "baseline");
    } else entry.folder = placementFolder(entry, keeper, root);
  }

  return entries;
}

/**
 * One entry per placed file and one per active duplicate stack.
 *
 * A set explicitly marked "not duplicates" is expanded back into its files:
 * its members may now land in unrelated folders, so keeping the old stack under
 * one former keeper would make the destination tree untrue. The set model above
 * remains available to Resolve so that decision can still be overridden.
 */
export function browseEntries(rows: readonly ReviewRow[], root = ""): BrowseEntry[] {
  const entries: BrowseEntry[] = [];
  const sets = new Map(duplicateSetEntries(rows, root).map((entry) => [entry.id, entry]));
  const emitted = new Set<string>();

  for (const row of rows) {
    const division = staysDivisionOf(row);
    if (row.stack === null || row.stack.decisionKind === "keep_all") {
      entries.push({
        kind: "file",
        key: `file:${row.source}`,
        row,
        folder: division === null ? folderOf(row, root) : staysFolder(division),
      });
      continue;
    }
    if (emitted.has(row.stack.id)) continue;
    const entry = sets.get(row.stack.id);
    if (entry !== undefined) entries.push(entry);
    emitted.add(row.stack.id);
  }

  return entries;
}

/** Every entry listed under a folder, including its descendants. */
export function entriesIn(entries: readonly BrowseEntry[], path: string | null): BrowseEntry[] {
  // The tree root has the deliberately empty path. It names the whole plan,
  // exactly as a cleared folder selection (`null`) does; treating it as a
  // literal folder name makes every placed path fail the `"/"` prefix test.
  // The root keeps its empty path because it is also the prefix from which
  // `folderGroups` derives top-level folders. This is the one normalization
  // point for selecting entries.
  if (path === null || path === "") return [...entries];
  return entries.filter((entry) => entry.folder === path || entry.folder.startsWith(`${path}/`));
}

// ── Which subfolder each file lands in ───────────────────────────────────────

/**
 * One immediate subfolder of the selected folder, and what lands in it.
 *
 * The tree said a folder held 2,206 files and the pane beside it listed 2,206
 * files flat — which answers "how many" and not "which ones, and where". That is
 * the question the destination tree raises and the one the screen exists for, so
 * the pane groups by the next folder down.
 */
export interface FolderGroup {
  /** Full path of the subfolder, or the selected folder itself for `direct`. */
  path: string;
  /** The segment to label it with. Empty for the direct group. */
  name: string;
  /** True for the files that land in the selected folder itself. */
  direct: boolean;
  entries: BrowseEntry[];
}

/**
 * The selected folder's contents, split by the subfolder each entry lands in.
 *
 * `selectedPath` of `null` groups the whole plan by its top-level folders. Files
 * landing in the selected folder itself come first, because "what is *here*" is
 * read before "what is below here". Everything else sorts as the tree does: date
 * folders alphabetically — which for date folders is chronologically — then the
 * review folders, then the branch for what the run will not place.
 */
export function folderGroups(
  entries: readonly BrowseEntry[],
  selectedPath: string | null,
): FolderGroup[] {
  const prefix = selectedPath ?? "";
  const direct: BrowseEntry[] = [];
  const byChild = new Map<string, BrowseEntry[]>();

  for (const entry of entries) {
    let relative: string | null;
    if (prefix === "") relative = entry.folder;
    else if (entry.folder === prefix) relative = "";
    else if (entry.folder.startsWith(`${prefix}/`))
      relative = entry.folder.slice(prefix.length + 1);
    // Not under the selection at all. `entriesIn` normally rules this out, but
    // grouping must not silently invent a bucket for something it was handed.
    else relative = null;

    if (relative === null) continue;
    if (relative === "") {
      direct.push(entry);
      continue;
    }
    const child = relative.split("/")[0];
    const existing = byChild.get(child);
    if (existing) existing.push(entry);
    else byChild.set(child, [entry]);
  }

  const rank = (path: string, name: string) =>
    path === STAYS_PATH || isStaysPath(path) ? 2 : REVIEW_FOLDERS.includes(name) ? 1 : 0;

  const groups: FolderGroup[] = [...byChild].map(([name, list]) => ({
    path: prefix === "" ? name : `${prefix}/${name}`,
    name,
    direct: false,
    entries: list,
  }));
  groups.sort(
    (a, b) => rank(a.path, a.name) - rank(b.path, b.name) || a.name.localeCompare(b.name),
  );

  return direct.length > 0
    ? [{ path: prefix, name: "", direct: true, entries: direct }, ...groups]
    : groups;
}

/** The ancestors of a browsing path, outermost first, for a breadcrumb. */
export function folderTrail(path: string | null): { path: string; name: string }[] {
  if (path === null || path === "") return [];
  const segments = path.split("/");
  return segments.map((name, index) => ({ path: segments.slice(0, index + 1).join("/"), name }));
}

// ── The tree ─────────────────────────────────────────────────────────────────

function emptyNode(name: string, path: string, isReview = false): TreeNode {
  return { name, path, count: 0, isReview, isNew: false, children: [] };
}

/**
 * The folder structure the run would build, counted in entries rather than rows.
 *
 * A set counts once, in the keeper's folder, because that is what the pane will
 * show there. Counting its members instead would put a number above a list that
 * does not contain that many things.
 */
export function browseTree(entries: readonly BrowseEntry[], rootName = "destination"): TreeNode {
  const root = emptyNode(rootName, "");
  const index = new Map<string, TreeNode>([["", root]]);

  for (const entry of entries) {
    if (entry.folder === "") {
      root.count += 1;
      continue;
    }
    root.count += 1;
    let parent = root;
    let prefix = "";
    for (const segment of entry.folder.split("/")) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      let node = index.get(prefix);
      if (node === undefined) {
        node = emptyNode(segment, prefix, REVIEW_FOLDERS.includes(segment));
        index.set(prefix, node);
        parent.children.push(node);
      }
      node.count += 1;
      parent = node;
    }
  }

  // The stays branch sorts last wherever it appears, then review folders, then
  // date folders alphabetically — which for date folders is chronologically.
  const rank = (node: TreeNode) => (node.path === STAYS_PATH ? 2 : node.isReview ? 1 : 0);
  const sortNode = (node: TreeNode): void => {
    node.children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/** Whether a tree path is the stays branch or one of its divisions. */
export function isStaysPath(path: string): boolean {
  return path === STAYS_PATH || path.startsWith(`${STAYS_PATH}/`);
}

/** The division a stays path names, or null for the branch itself. */
export function staysDivisionFor(path: string): StaysDivision | null {
  const division = path.startsWith(`${STAYS_PATH}/`) ? path.slice(STAYS_PATH.length + 1) : null;
  return STAYS_DIVISIONS.includes(division as StaysDivision) ? (division as StaysDivision) : null;
}

// ── The figures every surface reports ────────────────────────────────────────

export interface ReviewStats {
  /** Files the dry run looked at. */
  scanned: number;
  /** Files the run will place somewhere under the destination. */
  organized: number;
  /** Files it will set aside into a review folder rather than the date tree. */
  setAside: number;
  /** Files nothing happens to, whatever the reason. */
  staysPut: number;
  /** Duplicate sets this run holds, and the copies inside them it would park. */
  sets: number;
  copies: number;
  copyBytes: number;
  /** Sets with no decision. The run skips these whole. */
  undecided: number;
  /** Rule-ranked sets that still bind nothing. */
  proposed: number;
  /** Everything execution is waiting for. */
  outstanding: number;
  /** Percentages of the scan, for the distribution bar. */
  share: { organized: number; setAside: number; staysPut: number };
}

/** Whether an entry lands in one of the folders a person has to look at. */
function isSetAside(entry: BrowseEntry): boolean {
  const first = entry.folder.split("/")[0] ?? "";
  return REVIEW_FOLDERS.includes(first);
}

/**
 * The sets still waiting on a person, in the order Browse lists them.
 *
 * A set with a baseline is not in the queue: the reference always wins and
 * there is nothing to choose. Everything else with no chosen keeper is here —
 * and it is the same predicate the `_stays/undecided` division uses, so the
 * queue's length and that folder's count cannot disagree.
 */
export function resolveQueue(entries: readonly BrowseEntry[]): SetEntry[] {
  return entries.filter(
    (entry): entry is SetEntry =>
      entry.kind === "set" && isOutstandingState(entry.decisionState) && !entry.hasBaseline,
  );
}

/**
 * Every figure the screen quotes, from one pass over the same entries.
 *
 * The band, Browse and Resolve all read this. Three surfaces doing their own
 * arithmetic is exactly how a tile came to read "0 duplicates found" beside four
 * duplicate stacks, and one derivation is the only durable fix.
 */
export function reviewStats(
  rows: readonly ReviewRow[],
  entries: readonly BrowseEntry[],
): ReviewStats {
  let organized = 0;
  let setAside = 0;
  let staysPut = 0;
  let sets = 0;
  let copies = 0;
  let copyBytes = 0;
  let undecided = 0;
  let proposed = 0;

  for (const entry of entries) {
    const rowCount = entry.kind === "set" ? entry.rows.length : 1;
    if (isStaysPath(entry.folder)) staysPut += rowCount;
    else if (isSetAside(entry)) setAside += rowCount;
    else if (entry.kind === "set") {
      // The keeper is placed normally; its copies are set aside beside it.
      organized += 1;
      setAside += entry.rows.length - 1;
    } else organized += 1;
  }

  for (const entry of duplicateSetEntries(rows)) {
    sets += 1;
    if (!entry.hasBaseline && isUndecidedState(entry.decisionState)) undecided += 1;
    if (!entry.hasBaseline && isProposedState(entry.decisionState)) proposed += 1;
    if (entry.decisionKind === "keep_all") continue;
    for (const row of entry.rows) {
      if (row === entry.keeper) continue;
      copies += 1;
      copyBytes += row.sizeBytes;
    }
  }

  const scanned = rows.length;
  const pct = (value: number) => (scanned > 0 ? (value / scanned) * 100 : 0);
  return {
    scanned,
    organized,
    setAside,
    staysPut,
    sets,
    copies,
    copyBytes,
    undecided,
    proposed,
    outstanding: undecided + proposed,
    share: { organized: pct(organized), setAside: pct(setAside), staysPut: pct(staysPut) },
  };
}
