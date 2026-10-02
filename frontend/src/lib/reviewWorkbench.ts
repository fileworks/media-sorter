/**
 * The rules the duplicate workbench renders by.
 *
 * Everything here is pure so it can be tested without a DOM: which rows a
 * filter shows, what a decision will concretely do, what a bulk command would
 * touch, and where the "next unresolved group" is. The components stay thin on
 * top of it, which is what keeps a million-row list honest — the list never
 * decides anything, it only draws what these functions already decided.
 */

import type { KeeperPolicyId, PreviewItem } from "@/services/api";

/** Three kinds of stack, one shape. Mirrors the backend's `GroupKind`. */
export type GroupKind = "exact" | "similar" | "burst";

/**
 * Whether the catalog can produce burst stacks at all.
 *
 * Indexing writes perceptual signatures, capture time, and camera identity;
 * the detector consumes those catalog facts when the setting is enabled.
 *
 * The direct `POST /api/review/bursts/detect` endpoint that used to sit beside
 * this path has been removed: nothing in the app called it and no client in the
 * frontend spoke to it. Detection is reached through the catalog view alone.
 *
 * `P2-DEDUP-D3` landed the signature/facts producer — indexing now writes a
 * phash, a capture time and a camera model for every file — so `P2-DEDUP-D9`
 * flipped this back on. `burst_detection_enabled` alone decides again, which is
 * what a user setting should do. Proven rather than assumed: indexing two
 * frames two seconds apart from one camera yields a burst group, and the same
 * frames ninety minutes apart yield none
 * (`backend/tests/test_indexing_completeness.py::TestBurstStacksCanBeProduced`).
 *
 * Nothing gated by it ever wrote to the configuration, so a persisted
 * `burst_detection_enabled` survived both flips untouched and neither
 * direction needed a data migration.
 *
 * Typed `boolean` rather than left to literal inference so both branches stay
 * type-checked instead of one being narrowed away.
 */
export const CATALOG_BURST_GROUPS_AVAILABLE: boolean = true;
export type RootRole = "input" | "reference" | "destination";
export type DecisionAction = "keep" | "quarantine" | "skip" | "replace_keeper" | "keep_additional";
export type OutcomeKind =
  | "copy_to_destination"
  | "move_to_destination"
  | "quarantine"
  | "skip"
  | "no_action_reference"
  | "blocked";
export type ReviewState = "unresolved" | "reviewed" | "stale" | "executed";

export interface FactValue {
  known: boolean;
  value: unknown;
  issue: string | null;
}

export interface MemberFacts {
  size_bytes: number;
  modified_at: FactValue;
  captured_at: FactValue;
  width: FactValue;
  height: FactValue;
  duration_seconds: FactValue;
  codec: FactValue;
  media_kind: string;
}

export interface MemberEvidence {
  algorithm: string;
  sha256: string | null;
  signature: string | null;
  distance: number | null;
  threshold: number | null;
  confidence: "high" | "medium" | "low" | "unknown";
  extraction_issues: string[];
}

export interface GroupMember {
  member_id: string;
  root_id: string;
  role: RootRole;
  relative_path: string;
  observed_path: string;
  facts: MemberFacts;
  evidence: MemberEvidence;
}

export interface DuplicateGroup {
  group_id: string;
  kind: GroupKind;
  catalog_generation: number;
  rule_version: string;
  member_count: number;
  total_bytes: number;
  anchor_member_id: string | null;
  members: GroupMember[];
  evidence_summary: string;
}

export interface ResolvedOutcome {
  member_id: string;
  kind: OutcomeKind;
  destination_path: string | null;
  mutates_source: boolean;
  requires_acknowledgement: boolean;
  blocked_reason: string | null;
  explanation: string;
}

export interface GroupPlan {
  group_id: string;
  kind: GroupKind;
  state: ReviewState;
  decisions: { member_id: string; action: DecisionAction; reason: string }[];
  outcomes: ResolvedOutcome[];
  keeper_member_id: string | null;
  additional_keeps: string[];
  stale_reason: string | null;
}

// ── Facts ────────────────────────────────────────────────────────────────────

/** A fact, or the reason there isn't one. Never a fabricated zero. */
export function factLabel(fact: FactValue, format?: (value: unknown) => string): string {
  if (!fact.known || fact.value === null || fact.value === undefined) {
    return "unknown";
  }
  return format ? format(fact.value) : String(fact.value);
}

export function factTitle(fact: FactValue): string | undefined {
  return fact.known ? undefined : (fact.issue ?? "this could not be read");
}

export function resolutionLabel(facts: Pick<MemberFacts, "width" | "height">): string {
  if (!facts.width.known || !facts.height.known) return "unknown";
  return `${facts.width.value} × ${facts.height.value}`;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface GroupRow {
  groupId: string;
  kind: GroupKind;
  memberCount: number;
  roots: string[];
  potentialBytes: number;
  representativePath: string;
  confidence: MemberEvidence["confidence"];
  state: ReviewState;
  decided: number;
  hasReference: boolean;
  staleReason: string | null;
}

/**
 * The list row for one group.
 *
 * `potentialBytes` deliberately excludes the keeper and every protected
 * reference: it is what could be reclaimed, not what the group weighs.
 */
export function groupRow(group: DuplicateGroup, plan: GroupPlan | undefined): GroupRow {
  const keeperId = plan?.keeper_member_id ?? group.anchor_member_id ?? group.members[0]?.member_id;
  const reclaimable = group.members.filter(
    (member) => member.role !== "reference" && member.member_id !== keeperId,
  );
  const representative =
    group.members.find((member) => member.member_id === keeperId) ?? group.members[0];

  return {
    groupId: group.group_id,
    kind: group.kind,
    memberCount: group.member_count,
    roots: [...new Set(group.members.map((member) => member.root_id))].sort(),
    potentialBytes: reclaimable.reduce((sum, member) => sum + member.facts.size_bytes, 0),
    representativePath: representative?.relative_path ?? "",
    confidence: lowestConfidence(group.members),
    state: plan?.state ?? "unresolved",
    decided: plan?.decisions.length ?? 0,
    hasReference: group.members.some((member) => member.role === "reference"),
    staleReason: plan?.stale_reason ?? null,
  };
}

const CONFIDENCE_ORDER: MemberEvidence["confidence"][] = ["high", "medium", "low", "unknown"];

/** A group is only as trustworthy as its weakest piece of evidence. */
export function lowestConfidence(members: GroupMember[]): MemberEvidence["confidence"] {
  if (members.length === 0) return "unknown";
  return members
    .map((member) => member.evidence.confidence)
    .reduce((worst, current) =>
      CONFIDENCE_ORDER.indexOf(current) > CONFIDENCE_ORDER.indexOf(worst) ? current : worst,
    );
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface ReviewFilters {
  kind: GroupKind | "all";
  state: ReviewState | "all";
  search: string;
  minBytes: number;
  withReferencesOnly: boolean;
}

export const DEFAULT_FILTERS: ReviewFilters = {
  kind: "all",
  state: "all",
  search: "",
  minBytes: 0,
  withReferencesOnly: false,
};

export function filterRows(rows: GroupRow[], filters: ReviewFilters): GroupRow[] {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.kind !== "all" && row.kind !== filters.kind) return false;
    if (filters.state !== "all" && row.state !== filters.state) return false;
    if (filters.withReferencesOnly && !row.hasReference) return false;
    if (row.potentialBytes < filters.minBytes) return false;
    if (needle && !row.representativePath.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Identity of the current result scope.
 *
 * A bulk preview is frozen against this string. If the filter or the catalog
 * generation moves, the preview no longer describes what would happen and must
 * be recomputed rather than applied to an unseen set.
 */
export function filterKey(filters: ReviewFilters, catalogGeneration: number): string {
  return [
    catalogGeneration,
    filters.kind,
    filters.state,
    filters.search.trim().toLowerCase(),
    filters.minBytes,
    filters.withReferencesOnly ? "refs" : "all",
  ].join("|");
}

// ── Decisions ────────────────────────────────────────────────────────────────

export interface MemberAction {
  action: DecisionAction;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

/**
 * Which actions a member may be given.
 *
 * Reference members get none — and the reason is in the tooltip rather than in
 * a silent absence, so the protection reads as deliberate.
 */
export function availableActions(
  member: GroupMember,
  group: DuplicateGroup,
  plan: GroupPlan | undefined,
): MemberAction[] {
  if (member.role === "reference") {
    const reason = "Reference folders are compared against, never changed.";
    return [
      { action: "keep", label: "Protected", enabled: false, disabledReason: reason },
      { action: "quarantine", label: "Move to quarantine", enabled: false, disabledReason: reason },
    ];
  }
  const isKeeper = plan?.keeper_member_id === member.member_id;
  const actions: MemberAction[] = [
    { action: "keep", label: "Keep", enabled: !isKeeper },
    { action: "quarantine", label: "Move to quarantine", enabled: true },
    { action: "skip", label: "Skip", enabled: true },
  ];
  if (group.kind === "exact") {
    actions.push({
      action: "replace_keeper",
      label: "Make this the keeper",
      enabled: !isKeeper,
    });
  } else {
    actions.push({ action: "keep_additional", label: "Keep this version too", enabled: true });
  }
  return actions;
}

const OUTCOME_TEXT: Record<OutcomeKind, string> = {
  copy_to_destination: "Copied to the destination, kept where it is now",
  move_to_destination: "Moved to the destination after verification",
  quarantine: "Moved to quarantine — recoverable, never deleted",
  skip: "Left exactly where it is",
  no_action_reference: "Protected reference — nothing will touch it",
  blocked: "Cannot run",
};

export function outcomeLabel(outcome: ResolvedOutcome): string {
  return outcome.explanation || OUTCOME_TEXT[outcome.kind];
}

export function outcomeTone(outcome: ResolvedOutcome): "neutral" | "warning" | "danger" {
  if (outcome.kind === "blocked") return "danger";
  if (outcome.requires_acknowledgement || outcome.mutates_source) return "warning";
  return "neutral";
}

// ── Navigation ───────────────────────────────────────────────────────────────

/** The next group still needing a decision, wrapping to the start. */
export function nextUnresolved(rows: GroupRow[], currentGroupId: string | null): string | null {
  if (rows.length === 0) return null;
  const unresolved = rows.filter((row) => row.state === "unresolved" || row.state === "stale");
  if (unresolved.length === 0) return null;
  const index = unresolved.findIndex((row) => row.groupId === currentGroupId);
  return unresolved[(index + 1) % unresolved.length].groupId;
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

export type BulkScopeId =
  "this_group" | "selected_groups" | "current_filtered_exact" | "all_unresolved_exact";

export interface BulkImpact {
  scope: BulkScopeId;
  scope_generation: string;
  matched_groups: number;
  matched_members: number;
  skipped_groups: number;
  skipped_reasons: string[];
  source_mutations: number;
  quarantine_bytes: number;
  similar_groups_excluded: boolean;
}

export interface BulkImpactView {
  headline: string;
  lines: string[];
  /** True when the preview describes a scope that no longer exists. */
  invalidated: boolean;
  requiresAcknowledgement: boolean;
}

export function bulkImpactView(impact: BulkImpact, currentGeneration: string): BulkImpactView {
  const invalidated = impact.scope_generation !== currentGeneration;
  const lines = [
    `${impact.matched_groups.toLocaleString()} group(s), ${impact.matched_members.toLocaleString()} file(s) affected`,
    `${impact.quarantine_bytes.toLocaleString()} bytes would move to quarantine — nothing is deleted`,
  ];
  if (impact.source_mutations > 0) {
    lines.push(
      `${impact.source_mutations.toLocaleString()} of them are in your input folders, which Copy mode would otherwise leave untouched`,
    );
  }
  if (impact.skipped_groups > 0) {
    lines.push(`${impact.skipped_groups.toLocaleString()} group(s) skipped`);
  }
  if (impact.similar_groups_excluded) {
    lines.push("Similar-media groups are not included in exact policies");
  }
  return {
    headline: invalidated
      ? "The results changed — preview this again before applying"
      : "Review what this will do",
    lines,
    invalidated,
    requiresAcknowledgement: impact.source_mutations > 0,
  };
}

// ── Keep rules, decided here ─────────────────────────────────────────────────

/**
 * Which copy a keep rule would choose, or `null` when it refuses to choose.
 *
 * Mirrors `backend/app/services/keeper_policies.py::_choose` exactly, including
 * every tie-break, so the rule a user picks in Review and the rule the backend
 * applies from Configure cannot select different copies for the same set.
 *
 * It lives on the client because a keeper choice is now client-held run state:
 * applying a rule to two hundred sets used to be a preview-then-apply pair of
 * requests writing a server-side plan nothing read back. Deciding locally makes
 * a bulk apply instant *and* individually overridable, which is the property
 * that matters — a rule that cannot be argued with is not a review.
 *
 * A refusal is deliberate. Treating an unmeasured file as the smallest one is
 * how the only good copy gets quarantined, so those sets go to a person.
 */
export type KeeperRankingRung =
  | "copy_markers"
  | "path_depth"
  | "oldest_modified"
  | "newest_modified"
  | "largest_size"
  | "smallest_size"
  | "pixel_count"
  | "longest_filename"
  | "shortest_filename"
  | "stable_identity";

export interface KeeperRanking {
  memberId: string;
  /** The rule the selected policy tries first, whether or not it breaks the tie. */
  primaryRung: KeeperRankingRung;
  /** The first ordered criterion that left only the selected member. */
  decisiveRung: KeeperRankingRung;
  /** Every criterion actually consulted, with each compared member's raw fact. */
  trace: KeeperCriterionTrace[];
}

export interface KeeperCriterionTrace {
  rung: KeeperRankingRung;
  values: Record<string, number | string | null>;
  contendersAfter: number;
}

/**
 * Rank a group and retain the decisive criterion used by that same ordering.
 *
 * The explanation must not independently reimplement the policy: if selection
 * and prose each sort the members, one can drift while both test green. This
 * trace is therefore the source for both the selected id and the UI rationale.
 */
export function keeperRanking(group: DuplicateGroup, policy: KeeperPolicyId): KeeperRanking | null {
  const members = group.members;
  if (members.length === 0) return null;

  const pixels = (member: GroupMember): number | null => {
    const { width, height } = member.facts;
    if (!width.known || !height.known) return null;
    const value = Number(width.value ?? 0) * Number(height.value ?? 0);
    return Number.isFinite(value) ? value : null;
  };
  const size = (member: GroupMember) => member.facts.size_bytes;
  const modified = (member: GroupMember): number | null => {
    const fact = member.facts.modified_at;
    if (!fact.known || fact.value === null || fact.value === undefined) return null;
    const value = Number(fact.value);
    return Number.isFinite(value) ? value : null;
  };
  const filename = (member: GroupMember) =>
    member.relative_path.split(/[\\/]/).pop() ?? member.relative_path;
  // ── `smart` ────────────────────────────────────────────────────────────────
  // Mirrors `services/keeper_policies.py`. Every rung is pinned by
  // `contracts/keeper-golden-vector.json`, which is generated from the Python
  // side — so if these drift, the golden-vector test fails rather than a user
  // getting a different keeper in Review than the backend would have placed.
  const COPY_MARKERS = [
    " - copy",
    " - kopie",
    " copy",
    " kopie",
    "-copy",
    "_copy",
    " (copy)",
    " (kopie)",
  ];
  const COPY_PREFIXES = ["copy of ", "kopie von ", "duplicate of "];
  // Brackets are required: a bare trailing number is how cameras name files, so
  // counting "DSC_0002" as a copy of "DSC_0001" would treat half a memory card
  // as duplicates.
  const BRACKETED_COUNTER = /[ _-]*[([]\d{1,3}[)\]]$/;
  // A counter attached to the copy word itself is unambiguous: "IMG_0421 copy 2".
  const COPY_COUNTER = /(?:copy|kopie)[ _-]*\d{1,3}$/;

  const stem = (member: GroupMember) => {
    const name = filename(member);
    const dot = name.lastIndexOf(".");
    return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
  };

  /** How many signs there are that this name was machine-generated. */
  const copyMarks = (member: GroupMember): number => {
    // Read from the original stem rather than a partially stripped one, so the
    // result cannot depend on which marker happened to be removed first.
    const text = stem(member).trimEnd();
    let marks = 0;
    if (COPY_PREFIXES.some((prefix) => text.startsWith(prefix))) marks += 1;
    if (COPY_MARKERS.some((marker) => text.includes(marker))) marks += 1;
    if (BRACKETED_COUNTER.test(text)) marks += 1;
    if (COPY_COUNTER.test(text)) marks += 1;
    return marks;
  };

  /** How deeply buried the copy is: a library folder beats a backup folder. */
  const depth = (member: GroupMember) => (member.relative_path.match(/[\\/]/g) ?? []).length;
  // The last tie-break, and the reason a result never depends on scan order.
  const identity = (member: GroupMember) =>
    `${member.root_id}:${member.relative_path}:${member.member_id}`;

  interface Criterion {
    rung: KeeperRankingRung;
    value: (member: GroupMember) => number | string;
    display: (member: GroupMember) => number | string | null;
  }

  const best = (
    pool: readonly GroupMember[],
    criteria: readonly Criterion[],
  ): KeeperRanking | null => {
    if (pool.length === 0) return null;
    const sorted = [...pool].sort((a, b) => {
      for (const criterion of criteria) {
        const left = criterion.value(a);
        const right = criterion.value(b);
        if (left < right) return -1;
        if (left > right) return 1;
      }
      return 0;
    });
    const winner = sorted[0];
    let contenders = [...pool];
    let decisiveRung = criteria[criteria.length - 1].rung;
    const trace: KeeperCriterionTrace[] = [];
    for (const criterion of criteria) {
      const winningValue = criterion.value(winner);
      contenders = contenders.filter((member) => criterion.value(member) === winningValue);
      trace.push({
        rung: criterion.rung,
        values: Object.fromEntries(
          pool.map((member) => [member.member_id, criterion.display(member)]),
        ),
        contendersAfter: contenders.length,
      });
      if (contenders.length === 1) {
        decisiveRung = criterion.rung;
        break;
      }
    }
    return {
      memberId: winner.member_id,
      primaryRung: criteria[0].rung,
      decisiveRung,
      trace,
    };
  };

  switch (policy) {
    case "smart":
      // Exact-group members are byte-identical, so nothing about the content can
      // separate them. What differs is where they live and what they are called:
      // fewest copy marks, then shallowest path, then oldest, then largest, then
      // identity. An unknown mtime sorts last rather than reading as zero.
      return best(members, [
        { rung: "copy_markers", value: copyMarks, display: copyMarks },
        { rung: "path_depth", value: depth, display: depth },
        {
          rung: "oldest_modified",
          value: (m) => modified(m) ?? Number.POSITIVE_INFINITY,
          display: modified,
        },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "best_quality":
      // Most pixels, then most bytes. Unlike `highest_resolution` it does not
      // refuse a set whose dimensions could not all be read: a photo library is
      // full of files no parser handles, and refusing them all would leave the
      // common case undecided.
      return best(members, [
        { rung: "pixel_count", value: (m) => -(pixels(m) ?? 0), display: pixels },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        {
          rung: "newest_modified",
          value: (m) => -(modified(m) ?? 0),
          display: modified,
        },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "largest":
      return best(members, [
        { rung: "largest_size", value: (m) => -size(m), display: size },
        {
          rung: "newest_modified",
          value: (m) => -(modified(m) ?? 0),
          display: modified,
        },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "smallest":
      return best(members, [
        { rung: "smallest_size", value: size, display: size },
        {
          rung: "newest_modified",
          value: (m) => -(modified(m) ?? 0),
          display: modified,
        },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "longest_filename":
      return best(members, [
        {
          rung: "longest_filename",
          value: (m) => -filename(m).length,
          display: (m) => filename(m).length,
        },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "shortest_filename":
      return best(members, [
        {
          rung: "shortest_filename",
          value: (m) => filename(m).length,
          display: (m) => filename(m).length,
        },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    case "newest":
    case "oldest": {
      const dated = members.filter((member) => modified(member) !== null);
      if (dated.length === 0) return null;
      const sign = policy === "newest" ? -1 : 1;
      return best(dated, [
        {
          rung: policy === "newest" ? "newest_modified" : "oldest_modified",
          value: (m) => sign * (modified(m) ?? 0),
          display: modified,
        },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    }
    case "highest_resolution": {
      const measured = members.filter((member) => pixels(member) !== null);
      // Refuse rather than guess: one unreadable file must not be ranked last.
      if (measured.length !== members.length || measured.length === 0) return null;
      return best(measured, [
        { rung: "pixel_count", value: (m) => -(pixels(m) ?? 0), display: pixels },
        { rung: "largest_size", value: (m) => -size(m), display: size },
        { rung: "stable_identity", value: identity, display: (m) => m.relative_path },
      ]);
    }
    default:
      // `manual`, `protected_reference` and `preferred_root` never decide here:
      // the first is a refusal by definition, the second is automatic, and the
      // third needs a root order the interface no longer lets anyone set.
      return null;
  }
}

export function keeperByPolicy(group: DuplicateGroup, policy: KeeperPolicyId): string | null {
  return keeperRanking(group, policy)?.memberId ?? null;
}

// ── Comparison ───────────────────────────────────────────────────────────────

/**
 * One side of a comparison, whether or not it belongs to a duplicate set.
 *
 * Comparing used to require two members of the same group, so selecting any two
 * files that were not in one set returned without a word — a control that
 * silently does nothing is the worst kind of disabled. Two files can always be
 * put side by side; what depends on them sharing a set is only whether a
 * *keeper* can be chosen from the comparison, and that is stated rather than
 * enforced by silence.
 */
export interface ComparableFile {
  /** The member id where there is one, else the source path. */
  id: string;
  /** The path the thumbnail and diff endpoints take. */
  path: string;
  /** What to call it in the table. */
  label: string;
  /** Absent for a file the catalog holds no member record for. */
  facts: (Omit<MemberFacts, "size_bytes"> & { size_bytes: number | null }) | null;
  /** Which extractor supplied captured_at; null when the catalog did not record it. */
  capturedAtSource: string | null;
  confidence: MemberEvidence["confidence"] | null;
  protected?: boolean;
  companionCount?: number;
  unitId?: string | null;
  unitPrimary?: boolean | null;
  companions?: PreviewItem["companions"];
  unitWarnings?: string[];
  destination?: string | null;
  plannedStatus?: string | null;
}

export function comparableFromMember(
  member: GroupMember,
  capturedAtSource: string | null = null,
): ComparableFile {
  return {
    id: member.member_id,
    path: member.observed_path,
    label: member.relative_path,
    facts: member.facts,
    capturedAtSource,
    confidence: member.evidence.confidence,
    protected: member.role === "reference",
  };
}

/** A known fact, wrapped in the shape the fact table reads. */
function knownFact(value: unknown): FactValue {
  return { known: value !== null && value !== undefined, value, issue: null };
}

/**
 * A comparison side built from a plan row alone.
 *
 * Size and date come from the dry run; resolution does not, and is reported as
 * unknown rather than as a fabricated zero. The comparison is still worth
 * having — two thumbnails side by side answer "is this the same picture", which
 * is the question that brought the user here.
 */
export function comparableFromRow(row: {
  source: string;
  folder: string;
  name: string;
  sizeBytes: number | null;
  date: string | null;
  dateSource?: string | null;
  protected?: boolean;
  companionCount?: number;
  unitId?: string | null;
  unitPrimary?: boolean | null;
  companions?: PreviewItem["companions"];
  unitWarnings?: string[];
  destination?: string | null;
  status?: string;
}): ComparableFile {
  return {
    id: row.source,
    path: row.source,
    label: `${row.folder}/${row.name}`,
    facts: {
      size_bytes: row.sizeBytes,
      modified_at: knownFact(null),
      captured_at: knownFact(row.date),
      width: knownFact(null),
      height: knownFact(null),
      duration_seconds: knownFact(null),
      codec: knownFact(null),
      media_kind: "unknown",
    },
    capturedAtSource: row.dateSource ?? null,
    confidence: null,
    protected: row.protected ?? false,
    companionCount: row.companionCount ?? 0,
    unitId: row.unitId ?? null,
    unitPrimary: row.unitId ? (row.unitPrimary ?? null) : null,
    companions: row.companions,
    unitWarnings: row.unitWarnings,
    destination: row.destination ?? null,
    plannedStatus: row.status ?? null,
  };
}

/**
 * Every unordered pair of `count` items, as index pairs, in a stable order.
 *
 * `(0,1), (0,2), (1,2)` for three — the order a person would list them in, and
 * the order the pair stepper walks.
 */
export function pairsOf(count: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let first = 0; first < count; first += 1) {
    for (let second = first + 1; second < count; second += 1) pairs.push([first, second]);
  }
  return pairs;
}

/**
 * A copy's name within its set: A, B, C … then A2, B2 past the alphabet.
 *
 * The comparison used to letter the *sides of the screen* — whatever was on the
 * left was "A". In a set of two that is harmless, because the left side is
 * always the same copy. Past two it is actively wrong: stepping from the first
 * pair to the second silently redefined "A", so the badge over the image, the
 * keep radio and the facts column all changed meaning while the reader was
 * mid-comparison and nothing said so.
 *
 * The letter belongs to the copy for as long as the set is open. "Pair 2 of 3"
 * is then also readable as "A ↔ C", and which two of the four you have already
 * looked at is a question the screen can answer.
 */
export function memberLetter(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const cycle = Math.floor(index / 26);
  return cycle === 0 ? letter : `${letter}${cycle + 1}`;
}
