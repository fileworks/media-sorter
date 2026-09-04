import {
  keeperByPolicy,
  keeperRanking,
  type DuplicateGroup,
  type GroupMember,
  type KeeperRankingRung,
} from "@/lib/reviewWorkbench";
import type { KeeperPolicyId } from "@/services/api";

/** A binding answer for one duplicate set. */
export type DuplicateDecision = { kind: "keeper"; memberId: string } | { kind: "keep_all" };

/** A rule-ranked answer that remains non-binding until somebody accepts it. */
export interface KeeperProposal {
  memberId: string;
  policy: KeeperPolicyId;
  rationale: KeeperRationale;
}

/** Structured, reviewable evidence for a non-binding keeper proposal. */
export interface RationaleMessage {
  key: string;
  params?: Record<string, string | number>;
}

export interface KeeperRationale {
  primaryRung: RationaleMessage;
  winningRung: RationaleMessage;
  knownFacts: RationaleMessage[];
  unknownFacts: RationaleMessage[];
  tieBreak: RationaleMessage | null;
  limitation: RationaleMessage | null;
  comparisons: RationaleComparison[];
}

export interface RationaleComparison {
  member: string;
  selected: boolean;
  values: Array<{
    rung: RationaleMessage;
    value: number | string | null;
    format: "bytes" | "number" | "text";
  }>;
}

function memberName(member: GroupMember): string {
  return member.relative_path.split(/[\\/]/).pop() ?? member.relative_path;
}

function unknownFactMessages(group: DuplicateGroup, policy: KeeperPolicyId): RationaleMessage[] {
  const messages: RationaleMessage[] = [];
  if (["newest", "oldest", "smart"].includes(policy)) {
    const members = group.members
      .filter((member) => !member.facts.modified_at.known)
      .map(memberName);
    if (members.length > 0) {
      messages.push({
        key: "review.resolve.rationale.unknown.modifiedDate",
        params: { members: members.join(", ") },
      });
    }
  }
  if (["best_quality", "highest_resolution"].includes(policy)) {
    const members = group.members
      .filter((member) => !member.facts.width.known || !member.facts.height.known)
      .map(memberName);
    if (members.length > 0) {
      messages.push({
        key: "review.resolve.rationale.unknown.dimensions",
        params: { members: members.join(", ") },
      });
    }
  }
  return messages;
}

const RUNG_KEYS: Record<KeeperRankingRung, string> = {
  copy_markers: "review.resolve.rationale.rung.copyMarkers",
  path_depth: "review.resolve.rationale.rung.pathDepth",
  oldest_modified: "review.resolve.rationale.rung.oldestDate",
  newest_modified: "review.resolve.rationale.rung.newestDate",
  largest_size: "review.resolve.rationale.rung.largestSize",
  smallest_size: "review.resolve.rationale.rung.smallestSize",
  pixel_count: "review.resolve.rationale.rung.pixelCount",
  longest_filename: "review.resolve.rationale.rung.longestFilename",
  shortest_filename: "review.resolve.rationale.rung.shortestFilename",
  stable_identity: "review.resolve.rationale.rung.stableIdentity",
};

function valueFormat(rung: KeeperRankingRung): "bytes" | "number" | "text" {
  if (rung === "largest_size" || rung === "smallest_size") return "bytes";
  if (rung === "stable_identity") return "text";
  return "number";
}

function limitation(
  policy: KeeperPolicyId,
  unknownFacts: readonly RationaleMessage[],
): RationaleMessage | null {
  if (unknownFacts.length === 0) return null;
  if (policy === "best_quality") {
    return { key: "review.resolve.rationale.limitation.unmeasuredQuality" };
  }
  if (policy === "highest_resolution") {
    return { key: "review.resolve.rationale.limitation.allDimensionsRequired" };
  }
  if (policy === "newest" || policy === "oldest") {
    return { key: "review.resolve.rationale.limitation.undatedExcluded" };
  }
  if (policy === "smart") {
    return { key: "review.resolve.rationale.limitation.undatedLast" };
  }
  return null;
}

/** Explain the exact facts and limits behind the rule's current candidate. */
export function keeperRationale(
  group: DuplicateGroup,
  policy: KeeperPolicyId,
  memberId: string,
): KeeperRationale {
  const winner = group.members.find((member) => member.member_id === memberId);
  const ranking = keeperRanking(group, policy);
  const unknownFacts = unknownFactMessages(group, policy);
  const knownFacts: RationaleMessage[] = [
    {
      key: "review.resolve.rationale.fact.members",
      params: { count: group.member_count },
    },
    { key: `review.resolve.rationale.fact.match.${group.kind}` },
  ];
  if (winner !== undefined) {
    knownFacts.push({
      key: "review.resolve.rationale.fact.size",
      params: { bytes: winner.facts.size_bytes },
    });
    if (winner.facts.modified_at.known) {
      knownFacts.push({ key: "review.resolve.rationale.fact.modifiedDate" });
    }
    if (winner.facts.width.known && winner.facts.height.known) {
      knownFacts.push({
        key: "review.resolve.rationale.fact.dimensions",
        params: {
          width: Number(winner.facts.width.value ?? 0),
          height: Number(winner.facts.height.value ?? 0),
        },
      });
    }
  }
  const decisiveRung = ranking?.decisiveRung ?? "stable_identity";
  const primaryRung = ranking?.primaryRung ?? decisiveRung;
  return {
    primaryRung: { key: RUNG_KEYS[primaryRung] },
    winningRung: { key: RUNG_KEYS[decisiveRung] },
    knownFacts,
    unknownFacts,
    tieBreak:
      decisiveRung === primaryRung
        ? null
        : decisiveRung === "stable_identity"
          ? { key: "review.resolve.rationale.tie.stableIdentity" }
          : { key: RUNG_KEYS[decisiveRung] },
    limitation: limitation(policy, unknownFacts),
    comparisons: group.members.map((member) => ({
      member: memberName(member),
      selected: member.member_id === memberId,
      values: (ranking?.trace ?? []).map((criterion) => ({
        rung: { key: RUNG_KEYS[criterion.rung] },
        value: criterion.values[member.member_id] ?? null,
        format: valueFormat(criterion.rung),
      })),
    })),
  };
}

export type DuplicateDecisionState = "undecided" | "proposed" | "decided";

/** One predicate per state; every Review surface imports these definitions. */
export function isUndecidedState(state: DuplicateDecisionState): state is "undecided" {
  return state === "undecided";
}

export function isProposedState(state: DuplicateDecisionState): state is "proposed" {
  return state === "proposed";
}

export function isDecidedState(state: DuplicateDecisionState): state is "decided" {
  return state === "decided";
}

/** Proposals are non-binding, so both proposed and undecided are outstanding. */
export function isOutstandingState(state: DuplicateDecisionState): boolean {
  return !isDecidedState(state);
}

/**
 * Which copy the current rule ranks first, for every set it can rank.
 *
 * A recommendation is a *reading of the files*, so it does not stop existing
 * because the reader answered. Accepting one used to remove it — the map was
 * built only for undecided sets — and the compare dialog then said "there is
 * no recommendation for this set" about the very recommendation the user had
 * just taken. It survives the decision it produced, and every surface that
 * shows one shows it beside whatever was chosen.
 *
 * Protected references are answers supplied by the library contract rather
 * than anything a rule ranked, so they are excluded outright.
 */
export function keeperRecommendations(
  groups: readonly DuplicateGroup[],
  policy: KeeperPolicyId,
): Map<string, KeeperProposal> {
  const recommendations = new Map<string, KeeperProposal>();
  for (const group of groups) {
    if (group.members.some((member) => member.role === "reference")) continue;
    const memberId = keeperByPolicy(group, policy);
    if (memberId !== null) {
      recommendations.set(group.group_id, {
        memberId,
        policy,
        rationale: keeperRationale(group, policy, memberId),
      });
    }
  }
  return recommendations;
}

/**
 * The recommendations that are still *offers* — the ones nobody has answered.
 *
 * This is what "accept all recommendations" acts on and what the outstanding
 * count is measured against: a recommendation the user already took is not an
 * outstanding proposal, and reopening it would let one click overwrite a
 * decision that had been made deliberately.
 */
export function keeperProposals(
  groups: readonly DuplicateGroup[],
  policy: KeeperPolicyId,
  decisions: ReadonlyMap<string, DuplicateDecision>,
): Map<string, KeeperProposal> {
  const proposals = new Map<string, KeeperProposal>();
  for (const [groupId, recommendation] of keeperRecommendations(groups, policy)) {
    if (!decisions.has(groupId)) proposals.set(groupId, recommendation);
  }
  return proposals;
}

export function decisionState(
  setId: string,
  decisions: ReadonlyMap<string, DuplicateDecision>,
  proposals: ReadonlyMap<string, KeeperProposal>,
): DuplicateDecisionState {
  if (decisions.has(setId)) return "decided";
  if (proposals.has(setId)) return "proposed";
  return "undecided";
}

/** Stable set identity for catalog rows, used by folder-scoped bulk choices. */
export function sourceFolder(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0
    ? normalized.slice(0, Math.max(separator, 0))
    : normalized.slice(0, separator);
}
