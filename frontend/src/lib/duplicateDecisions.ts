import { keeperByPolicy, type DuplicateGroup } from "@/lib/reviewWorkbench";
import type { KeeperPolicyId } from "@/services/api";

/** A binding answer for one duplicate set. */
export type DuplicateDecision = { kind: "keeper"; memberId: string } | { kind: "keep_all" };

/** A rule-ranked answer that remains non-binding until somebody accepts it. */
export interface KeeperProposal {
  memberId: string;
  policy: KeeperPolicyId;
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
 * Propose for every catalog set the current rule can rank.
 *
 * Decisions are deliberately excluded: changing the rule replaces outstanding
 * proposals but cannot rewrite an answer somebody already gave. Protected
 * references are answers supplied by the library contract, not proposals.
 */
export function keeperProposals(
  groups: readonly DuplicateGroup[],
  policy: KeeperPolicyId,
  decisions: ReadonlyMap<string, DuplicateDecision>,
): Map<string, KeeperProposal> {
  const proposals = new Map<string, KeeperProposal>();
  for (const group of groups) {
    if (decisions.has(group.group_id)) continue;
    if (group.members.some((member) => member.role === "reference")) continue;
    const memberId = keeperByPolicy(group, policy);
    if (memberId !== null) proposals.set(group.group_id, { memberId, policy });
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
