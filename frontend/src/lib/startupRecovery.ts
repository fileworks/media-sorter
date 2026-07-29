/**
 * What the app must say — and refuse — when it starts after an interrupted run.
 *
 * The backend reconciles what it can prove and leaves the rest classified as
 * ambiguous. This module decides what that means for the user: which artifacts
 * are safe to resolve automatically, which need a decision, and when starting a
 * new operation has to be blocked so a second run cannot overwrite the evidence
 * the first one left behind.
 */

export type ArtifactKind = "stage" | "original" | "result" | "quarantined";

export interface RecoveryArtifact {
  action_id: string;
  kind: ArtifactKind;
  path: string;
  /** Set when the backend proved this artifact matches its manifest hash. */
  verified: boolean;
  /** Whether another verified copy of the same content is known to exist. */
  redundant: boolean;
}

export interface RecoveryOperation {
  operation_id: string;
  started_at: string;
  state: "reconciliation_required" | "active" | "completed" | "failed" | "cancelled";
  artifacts: RecoveryArtifact[];
}

export type Classification = "safe_to_discard" | "safe_to_keep" | "needs_decision";

export interface ClassifiedArtifact {
  artifact: RecoveryArtifact;
  classification: Classification;
  /** The one sentence shown next to it. */
  explanation: string;
}

/**
 * Classify one leftover artifact.
 *
 * Only two things may be resolved without asking: a staged temporary file whose
 * content exists elsewhere, and a verified result. Everything else is a
 * decision, because discarding it could be the last copy of something.
 */
export function classify(artifact: RecoveryArtifact): ClassifiedArtifact {
  if (artifact.kind === "stage" && artifact.redundant) {
    return {
      artifact,
      classification: "safe_to_discard",
      explanation: "A partial copy whose content is already verified elsewhere.",
    };
  }
  if (artifact.kind === "result" && artifact.verified) {
    return {
      artifact,
      classification: "safe_to_keep",
      explanation: "A finished, verified file. Nothing further is needed.",
    };
  }
  if (artifact.kind === "original" && artifact.verified) {
    return {
      artifact,
      classification: "safe_to_keep",
      explanation: "Your original, verified and untouched.",
    };
  }
  if (artifact.kind === "quarantined") {
    return {
      artifact,
      classification: "safe_to_keep",
      explanation: "Held in quarantine. It can be restored at any time.",
    };
  }
  return {
    artifact,
    classification: "needs_decision",
    explanation:
      "This could not be matched to a verified copy, so it is kept until you decide what it is.",
  };
}

export interface RecoveryPlan {
  operationId: string;
  artifacts: ClassifiedArtifact[];
  automatic: ClassifiedArtifact[];
  decisions: ClassifiedArtifact[];
  /** New work is blocked while any decision is outstanding. */
  blocksNewOperations: boolean;
  headline: string;
  guidance: string;
}

export function buildRecoveryPlan(operation: RecoveryOperation): RecoveryPlan {
  const artifacts = operation.artifacts.map(classify);
  const decisions = artifacts.filter((item) => item.classification === "needs_decision");
  const automatic = artifacts.filter((item) => item.classification !== "needs_decision");

  return {
    operationId: operation.operation_id,
    artifacts,
    automatic,
    decisions,
    blocksNewOperations: decisions.length > 0,
    headline:
      decisions.length > 0
        ? `${decisions.length} item${decisions.length === 1 ? "" : "s"} from an interrupted run need${decisions.length === 1 ? "s" : ""} your decision`
        : "An interrupted run was reconciled automatically",
    guidance:
      decisions.length > 0
        ? "Nothing was deleted. Review each item and choose whether to keep or discard it before starting new work."
        : "Every leftover was matched to a verified copy. No files were lost and no action is needed.",
  };
}

export interface StartBlock {
  blocked: boolean;
  reason: string | null;
  /** The operation that must be resolved first, if any. */
  operationId: string | null;
}

/**
 * Whether a new operation may start.
 *
 * Blocking is deliberately narrow: only outstanding *decisions* block. An
 * operation that reconciled itself cleanly must not hold the app hostage.
 */
export function startBlock(operations: RecoveryOperation[]): StartBlock {
  for (const operation of operations) {
    if (operation.state !== "reconciliation_required") continue;
    const plan = buildRecoveryPlan(operation);
    if (plan.blocksNewOperations) {
      return {
        blocked: true,
        reason: plan.headline,
        operationId: operation.operation_id,
      };
    }
  }
  return { blocked: false, reason: null, operationId: null };
}
