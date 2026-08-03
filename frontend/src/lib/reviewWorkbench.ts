/**
 * The rules the duplicate workbench renders by.
 *
 * Everything here is pure so it can be tested without a DOM: which rows a
 * filter shows, what a decision will concretely do, what a bulk command would
 * touch, and where the "next unresolved group" is. The components stay thin on
 * top of it, which is what keeps a million-row list honest — the list never
 * decides anything, it only draws what these functions already decided.
 */

/** Three kinds of stack, one shape. Mirrors the backend's `GroupKind`. */
export type GroupKind = "exact" | "similar" | "burst";
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

export function resolutionLabel(facts: MemberFacts): string {
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
  | "this_group"
  | "selected_groups"
  | "current_filtered_exact"
  | "all_unresolved_exact";

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

// ── Persistence ──────────────────────────────────────────────────────────────

export interface ReviewUiState {
  filters: ReviewFilters;
  selectedGroupId: string | null;
  scrollTop: number;
  view: "overview" | "organization" | "exact" | "similar" | "validation" | "issues";
}

export const REVIEW_STATE_KEY = "mediasort_review_state";

/**
 * Persisted UI state, deliberately without absolute paths.
 *
 * A restored session should reopen the same view and filter, not leak where
 * somebody's photos live into browser storage.
 */
export function serializeUiState(state: ReviewUiState): string {
  return JSON.stringify({
    filters: { ...state.filters, search: "" },
    selectedGroupId: state.selectedGroupId,
    scrollTop: Math.round(state.scrollTop),
    view: state.view,
  });
}

export function deserializeUiState(raw: string | null): ReviewUiState {
  const fallback: ReviewUiState = {
    filters: DEFAULT_FILTERS,
    selectedGroupId: null,
    scrollTop: 0,
    view: "overview",
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewUiState>;
    return {
      filters: { ...DEFAULT_FILTERS, ...(parsed.filters ?? {}) },
      selectedGroupId: parsed.selectedGroupId ?? null,
      scrollTop: parsed.scrollTop ?? 0,
      view: parsed.view ?? "overview",
    };
  } catch {
    return fallback;
  }
}
