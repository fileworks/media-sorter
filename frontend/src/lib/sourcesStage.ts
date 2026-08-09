/**
 * The Sources stage: which folders, what each one is for, and what conflicts.
 *
 * A location card is not decoration. The role decides whether a folder can be
 * written to at all, and getting that wrong is how somebody's reference library
 * gets reorganized. So overlap validation runs here, names both sides of every
 * conflict, and blocks rather than warns when the combination is unsafe.
 */

export type RootRole = "input" | "reference" | "destination";
/**
 * What the last probe of this folder found.
 *
 * `unknown` has not been probed, `checking` is in flight. The rest are answers
 * from `/api/fs/list`, which is also what validates a destination, so a card
 * and the run can never disagree about whether a folder is usable.
 */
export type RootState =
  "unknown" | "checking" | "ready" | "offline" | "unreadable" | "missing" | "not_writable";

export interface RootCard {
  rootId: string;
  role: RootRole;
  path: string;
  displayName: string | null;
  priority: number;
  exclusions: string[];
  state: RootState;
  /** Volume label, when the platform could resolve one. */
  volume: string | null;
  freshness: "fresh" | "stale" | "unknown";
  /** Files the last completed scan saw, when there was one. */
  indexedFiles: number | null;
  issueCount: number;
}

export const ROLE_LABEL: Record<RootRole, string> = {
  input: "Input",
  reference: "Reference",
  destination: "Destination",
};

export const ROLE_DESCRIPTION: Record<RootRole, string> = {
  input: "Files here are organized into the destination.",
  reference: "Compared against, never changed.",
  destination: "Where organized files are written.",
};

// ── Validation ───────────────────────────────────────────────────────────────

export type ConflictKind =
  | "duplicate_path"
  | "destination_inside_input"
  | "input_inside_destination"
  | "reference_overlaps_mutable"
  | "no_input"
  | "no_destination"
  | "multiple_destinations"
  | "no_readable_input"
  | "destination_missing"
  | "destination_unreadable"
  | "destination_not_writable"
  | "offline";

export interface Conflict {
  kind: ConflictKind;
  /** Both sides, by root id, so the UI can highlight exactly what clashes. */
  rootIds: string[];
  message: string;
  blocking: boolean;
  /** What the user can do about it, when there is a specific answer. */
  remedy: string | null;
  /** Values needed to render the same finding through the locale catalogue. */
  params?: Record<string, string | number>;
}

function normalize(path: string): string {
  return path
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * Whether `inner` is inside `outer` — by path segment, not by prefix.
 *
 * A prefix test says `/photos-old` is inside `/photos`, which would reject a
 * perfectly valid pair of sibling folders. Segment comparison is the difference
 * between a validator people trust and one they route around.
 */
export function isWithin(inner: string, outer: string): boolean {
  const a = normalize(inner).split("/");
  const b = normalize(outer).split("/");
  if (b.length > a.length) return false;
  return b.every((segment, index) => segment === a[index]);
}

export function validateRoots(cards: RootCard[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const inputs = cards.filter((card) => card.role === "input");
  const destinations = cards.filter((card) => card.role === "destination");

  if (inputs.length === 0) {
    conflicts.push({
      kind: "no_input",
      rootIds: [],
      message: "Add at least one input folder.",
      blocking: true,
      remedy: "Choose the folder holding the files you want organized.",
    });
  }
  if (destinations.length === 0) {
    conflicts.push({
      kind: "no_destination",
      rootIds: [],
      message: "Add a destination folder.",
      blocking: true,
      remedy: "Choose where organized files should go.",
    });
  }
  if (destinations.length > 1) {
    conflicts.push({
      kind: "multiple_destinations",
      rootIds: destinations.map((card) => card.rootId),
      message: "Only one destination folder is supported.",
      blocking: true,
      remedy: "Remove the extra destination, or make it a reference.",
      params: { count: destinations.length },
    });
  }

  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i];
      const b = cards[j];
      if (normalize(a.path) === normalize(b.path)) {
        conflicts.push({
          kind: "duplicate_path",
          rootIds: [a.rootId, b.rootId],
          message: `${a.path} is listed twice, as ${ROLE_LABEL[a.role]} and ${ROLE_LABEL[b.role]}.`,
          blocking: true,
          remedy: "Remove one of them, or point it at a different folder.",
          params: {
            path: a.path,
            firstRole: a.role,
            secondRole: b.role,
          },
        });
        continue;
      }
      const conflict = pairConflict(a, b) ?? pairConflict(b, a);
      if (conflict) conflicts.push(conflict);
    }
  }

  // A run needs one folder it can actually read and one it can actually write.
  // Without these the stage would open on a configuration the sort then refuses.
  const usableInputs = inputs.filter(
    (card) => card.state === "ready" || card.state === "unknown" || card.state === "checking",
  );
  if (inputs.length > 0 && usableInputs.length === 0) {
    conflicts.push({
      kind: "no_readable_input",
      rootIds: inputs.map((card) => card.rootId),
      message: "No input folder can be read.",
      blocking: true,
      remedy: "Reconnect the drive, or choose an input folder that exists and is readable.",
    });
  }

  for (const destination of destinations) {
    const name = destination.displayName ?? destination.path;
    if (destination.state === "missing") {
      conflicts.push({
        kind: "destination_missing",
        rootIds: [destination.rootId],
        message: `The destination ${name} no longer exists.`,
        blocking: true,
        remedy: "Choose a destination folder that exists.",
        params: { name },
      });
    } else if (destination.state === "unreadable") {
      conflicts.push({
        kind: "destination_unreadable",
        rootIds: [destination.rootId],
        message: `The destination ${name} cannot be read.`,
        blocking: true,
        remedy: "Fix its permissions, or choose a different destination.",
        params: { name },
      });
    } else if (destination.state === "not_writable") {
      conflicts.push({
        kind: "destination_not_writable",
        rootIds: [destination.rootId],
        message: `The destination ${name} cannot be written to.`,
        blocking: true,
        remedy: "Fix its permissions, or choose a destination you can write to.",
        params: { name },
      });
    }
  }

  for (const card of cards) {
    if (card.state === "missing" && card.role !== "destination") {
      conflicts.push({
        kind: "offline",
        rootIds: [card.rootId],
        message: `${card.displayName ?? card.path} no longer exists.`,
        blocking: card.role !== "reference",
        remedy:
          card.role === "reference"
            ? "Reconnect it, or remove it — comparisons will be less complete."
            : "Reconnect the drive, or point this folder somewhere else.",
        params: { name: card.displayName ?? card.path, state: card.state },
      });
      continue;
    }
    if (card.role === "destination" && card.state === "unreadable") continue;
    if (card.state === "offline" || card.state === "unreadable") {
      conflicts.push({
        kind: "offline",
        rootIds: [card.rootId],
        message: `${card.displayName ?? card.path} is ${
          card.state === "offline" ? "not connected" : "unreadable"
        }.`,
        blocking: card.role !== "reference",
        remedy:
          card.role === "reference"
            ? "Reconnect it, or exclude it from this run — comparisons will be less complete."
            : "Reconnect the drive, or point this folder somewhere else.",
        params: {
          name: card.displayName ?? card.path,
          state: card.state,
        },
      });
    }
  }

  return conflicts;
}

function pairConflict(a: RootCard, b: RootCard): Conflict | null {
  if (!isWithin(a.path, b.path)) return null;

  if (a.role === "destination" && b.role === "input") {
    return {
      kind: "destination_inside_input",
      rootIds: [a.rootId, b.rootId],
      message: `The destination ${a.path} is inside the input ${b.path}.`,
      blocking: true,
      remedy: "Put the destination outside the input, or exclude it from the input.",
      params: { destination: a.path, input: b.path },
    };
  }
  if (a.role === "input" && b.role === "destination") {
    return {
      kind: "input_inside_destination",
      rootIds: [a.rootId, b.rootId],
      message: `The input ${a.path} is inside the destination ${b.path}.`,
      blocking: true,
      remedy: "Choose an input outside the destination.",
      params: { input: a.path, destination: b.path },
    };
  }
  if (a.role === "reference" && b.role !== "reference") {
    return {
      kind: "reference_overlaps_mutable",
      rootIds: [a.rootId, b.rootId],
      message: `The reference ${a.path} is inside ${ROLE_LABEL[b.role].toLowerCase()} ${b.path}, so it would be changed.`,
      blocking: true,
      remedy: "Move the reference outside, or exclude it from that folder.",
      params: { reference: a.path, role: b.role, path: b.path },
    };
  }
  return null;
}

export function blockingConflicts(conflicts: Conflict[]): Conflict[] {
  return conflicts.filter((conflict) => conflict.blocking);
}

export interface SourcesReadiness {
  ready: boolean;
  reason: string | null;
  warnings: string[];
}

export function sourcesReadiness(cards: RootCard[]): SourcesReadiness {
  const conflicts = validateRoots(cards);
  const blocking = blockingConflicts(conflicts);
  return {
    ready: blocking.length === 0,
    reason: blocking[0]?.message ?? null,
    warnings: conflicts
      .filter((conflict) => !conflict.blocking)
      .map((conflict) => conflict.message),
  };
}

// ── Interactions ─────────────────────────────────────────────────────────────

export interface Remap {
  rootId: string;
  fromPath: string;
  toPath: string;
  /** True when the new location is on a different volume than before. */
  volumeChanged: boolean;
}

/**
 * Point an offline root somewhere else, and say what that invalidates.
 *
 * A remapped root keeps its identity so the plan and the index still refer to
 * it — but if the volume changed, everything derived from file identity has to
 * be re-established, and the user should hear that before agreeing.
 */
export function remapImpact(remap: Remap): string[] {
  const impact = ["Anything already reviewed for this folder will need looking at again."];
  if (remap.volumeChanged) {
    impact.push("The folder is on a different drive, so its index entries will be rebuilt.");
  }
  return impact;
}

export function applyRemap(cards: RootCard[], remap: Remap): RootCard[] {
  return cards.map((card) =>
    card.rootId === remap.rootId
      ? { ...card, path: remap.toPath, state: "unknown", freshness: "unknown", indexedFiles: null }
      : card,
  );
}

/** Exclude a root for one run without removing it from the saved profile. */
export function excludeForRun(excluded: string[], rootId: string): string[] {
  return excluded.includes(rootId) ? excluded : [...excluded, rootId];
}

export function activeCards(cards: RootCard[], excludedForRun: string[]): RootCard[] {
  return cards.filter((card) => !excludedForRun.includes(card.rootId));
}

/** Move a root up or down the priority order, keeping the order contiguous. */
export function reorder(cards: RootCard[], rootId: string, direction: -1 | 1): RootCard[] {
  const sorted = [...cards].sort((a, b) => a.priority - b.priority);
  const index = sorted.findIndex((card) => card.rootId === rootId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sorted.length) return cards;
  [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
  return sorted.map((card, position) => ({ ...card, priority: position }));
}

export interface RoleChange {
  cards: RootCard[];
  /** Conflicts the change would introduce, computed before it is committed. */
  conflicts: Conflict[];
}

export function changeRole(cards: RootCard[], rootId: string, role: RootRole): RoleChange {
  const next = cards.map((card) => (card.rootId === rootId ? { ...card, role } : card));
  return { cards: next, conflicts: validateRoots(next) };
}

export interface CardStatus {
  tone: "ready" | "warning" | "error";
  label: string;
  detail: string;
}

export function cardStatus(card: RootCard, conflicts: Conflict[]): CardStatus {
  const own = conflicts.filter((conflict) => conflict.rootIds.includes(card.rootId));
  const blocking = own.find((conflict) => conflict.blocking);
  if (blocking) {
    return { tone: "error", label: "Conflict", detail: blocking.message };
  }
  if (own.length > 0) {
    return { tone: "warning", label: "Check this", detail: own[0].message };
  }
  if (card.state === "checking") {
    return { tone: "warning", label: "Checking…", detail: "Looking at this folder." };
  }
  if (card.state === "missing") {
    return { tone: "error", label: "Missing", detail: "This folder no longer exists." };
  }
  if (card.state === "not_writable") {
    return { tone: "error", label: "Read-only", detail: "This folder cannot be written to." };
  }
  if (card.state === "unreadable") {
    return { tone: "error", label: "Unreadable", detail: "This folder cannot be read." };
  }
  if (card.state === "unknown") {
    return {
      tone: "warning",
      label: "Not checked",
      detail: "This folder has not been scanned yet.",
    };
  }
  const indexed =
    card.indexedFiles === null ? "not indexed" : `${card.indexedFiles.toLocaleString()} files`;
  const freshness =
    card.freshness === "fresh"
      ? "up to date"
      : card.freshness === "stale"
        ? "not scanned recently"
        : "never fully scanned";
  return { tone: "ready", label: "Ready", detail: `${indexed} · ${freshness}` };
}
