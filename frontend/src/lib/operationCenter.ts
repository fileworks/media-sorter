/**
 * The persistent operation center, and the last screen before anything moves.
 *
 * Progress, history, and reports are one surface rather than three stages: an
 * operation keeps running while you look at something else, and its outcome has
 * to be findable afterwards without hunting.
 *
 * The Execute preflight is the other half. It states exactly what will happen —
 * counts, bytes, source mutations, what stays untouched — and refuses to start
 * while anything is stale, unacknowledged, or short of space.
 */

import { formatBytes } from "@/lib/formatters";
import type { DiagnosticsResponse, OperationListItem } from "@/services/api";
import type { RecoveryOperation } from "@/lib/startupRecovery";
import type { OperationOutcome } from "./statusPresentation";

export interface OperationSummary {
  operationId: string;
  kind: "scan" | "preview" | "sort" | "review" | "cleanup" | "restore";
  startedAt: string;
  finishedAt: string | null;
  outcome: OperationOutcome | null;
  counts: {
    verified_success: number;
    warnings: number;
    skipped: number;
    quarantined: number;
    failed: number;
    unresolved: number;
  };
  /** Bytes the run wrote, or null when no source reports them. Never a guessed 0. */
  bytesWritten: number | null;
  reportId: string | null;
  recoveryState: "none" | "available" | "required";
}

/**
 * Every operation the center can show, newest first, running one included.
 *
 * Reports provide the completed runs; diagnostics provides the one task that
 * may still be going. Combining them is what makes the center answerable from
 * any stage rather than only from Execute — and it is a data transform over two
 * API shapes, so it belongs beside the type it produces rather than in the page
 * that happens to render it.
 */
export function operationSummaries(
  operations: readonly OperationListItem[],
  activeTask: DiagnosticsResponse["active_task"],
  recoveryOperations: readonly RecoveryOperation[],
): OperationSummary[] {
  const finished: OperationSummary[] = operations.map((operation) => ({
    operationId: operation.id,
    kind: "sort" as const,
    startedAt: operation.started_at ?? operation.execution_date,
    finishedAt: operation.finished_at,
    // Historical records can predate the explicit outcome enum. They remain
    // visible in the center as needing attention instead of masquerading as a
    // successful completed run.
    outcome: operation.outcome === "unknown" ? "failed" : operation.outcome,
    counts: {
      verified_success: operation.files_sorted,
      warnings: operation.incomplete_units + operation.unmatched_companions,
      skipped: operation.files_skipped + operation.already_in_destination,
      quarantined:
        operation.future_dates +
        operation.unknown_dates +
        operation.corrupted_files +
        operation.junk_files,
      failed: operation.files_failed,
      unresolved: operation.remaining_files,
    },
    bytesWritten: null,
    reportId: operation.id,
    recoveryState: recoveryOperations.some((item) => item.operation_id === operation.id)
      ? ("required" as const)
      : ("none" as const),
  }));

  if (activeTask === null) return finished;
  const kind =
    activeTask.operation_kind === "sort"
      ? "sort"
      : activeTask.operation_kind === "preview"
        ? "preview"
        : "scan";
  return [
    {
      operationId: activeTask.task_id,
      kind,
      startedAt: activeTask.started_at ?? new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      counts: {
        verified_success: 0,
        warnings: 0,
        skipped: 0,
        quarantined: 0,
        failed: 0,
        unresolved: 0,
      },
      bytesWritten: null,
      reportId: null,
      recoveryState: "none" as const,
    },
    ...finished,
  ];
}

export interface CenterState {
  /** The operation currently running, when there is one. */
  active: OperationSummary | null;
  recent: OperationSummary[];
  /** Operations whose outcome the user has not seen yet. */
  unread: string[];
}

export function isRunning(operation: OperationSummary): boolean {
  return operation.outcome === null;
}

/**
 * Fold a list of operations into what the center displays.
 *
 * At most one operation runs at a time; if several look active, the newest wins
 * and the rest are treated as finished-but-unrecorded, because showing two
 * concurrent runs would imply a concurrency the backend does not offer.
 */
export function centerState(operations: OperationSummary[], seen: string[] = []): CenterState {
  const sorted = [...operations].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const active = sorted.find(isRunning) ?? null;
  return {
    active,
    recent: sorted.filter((operation) => operation.operationId !== active?.operationId),
    unread: sorted
      .filter(
        (operation) =>
          !isRunning(operation) &&
          !seen.includes(operation.operationId) &&
          operation.outcome !== "completed",
      )
      .map((operation) => operation.operationId),
  };
}

export interface CenterBadge {
  /** Number shown on the collapsed center; zero means no badge. */
  count: number;
  tone: "neutral" | "info" | "warning" | "error";
}

export function centerBadge(state: CenterState): CenterBadge {
  if (state.active) {
    return { count: 1, tone: "info" };
  }
  const needsAttention = state.recent.filter(
    (operation) => operation.recoveryState === "required" || operation.counts.failed > 0,
  );
  if (needsAttention.length > 0) {
    return { count: needsAttention.length, tone: "error" };
  }
  if (state.unread.length > 0) {
    return { count: state.unread.length, tone: "warning" };
  }
  return { count: 0, tone: "neutral" };
}

// ── Execute preflight ────────────────────────────────────────────────────────

export interface PreflightInput {
  /** A successful request for the exact current decision fingerprint. */
  impactState: "loading" | "ready" | "error";
  /** Groups whose decisions would run. */
  actionableGroups: number;
  quarantineCount: number;
  quarantineBytes: number;
  copyCount: number;
  moveCount: number;
  skipCount: number;
  /** Reference folders this run reads but never writes. */
  referenceFolders: number;
  /** Actions that change an input folder under Copy mode. */
  sourceMutations: number;
  acknowledgedSourceMutations: boolean;
  /** Files whose duplicate check preview could not finish; the run leaves them in place. */
  unresolvedFiles: number;
  freeBytes: number | null;
  /**
   * Bytes the run needs, or `null` when nobody could work it out — no frozen
   * impact yet, or a plan carrying sizes that could not be read. Unknown is not
   * zero: coercing it to `0` made the capacity check below pass unconditionally
   * and report an all-clear it had not earned (I-10).
   */
  requiredBytes: number | null;
  /**
   * Permanently 0 since `P0-SAFE-001`: conversion quarantines the file it
   * replaces instead of discarding it, so there is no longer a case where an
   * original "will not be retained". Kept on the input so an older backend's
   * preflight still type-checks, and asserted to stay 0 rather than deleted —
   * a field that silently disappeared would look the same as one that was
   * never sent.
   */
  conversionWithoutOriginals: number;
  companionsLeftInPlace: number;
  embeddedTagCount: number;
}

export interface PreflightLine {
  text: string;
  tone: "neutral" | "warning" | "error";
  messageKey?: string;
  params?: Record<string, string | number>;
}

export interface Preflight {
  /** No blocking line remains. */
  canExecute: boolean;
  /**
   * The one rule the Execute button follows: nothing blocks and this exact plan
   * was acknowledged. Every plan needs the acknowledgement, Copy included.
   */
  executable: boolean;
  blocking: PreflightLine[];
  summary: PreflightLine[];
  reversible: PreflightLine[];
  irreversible: PreflightLine[];
  /**
   * The acknowledgement sentence for this plan. It depends only on what the plan
   * does, so ticking the box never swaps the warning for a milder one.
   */
  acknowledgement: string;
  acknowledgementKey: "preflight.acknowledge" | "preflight.acknowledge.mutations";
}

/**
 * Everything that must be true before Execute is pressable.
 *
 * Ordered by what the user should fix first: stale review, then acknowledgement,
 * then capacity. A screen that reports three problems at once teaches people to
 * skim it.
 */
export function preflight(input: PreflightInput): Preflight {
  const blocking: PreflightLine[] = [];

  if (input.impactState === "loading") {
    blocking.push({
      text: "The exact impact is still being calculated.",
      tone: "warning",
      messageKey: "preflight.blocking.impactLoading",
    });
  } else if (input.impactState === "error") {
    blocking.push({
      text: "The exact impact could not be verified. Return to Review and try again.",
      tone: "error",
      messageKey: "preflight.blocking.impactError",
    });
  }

  if (input.actionableGroups === 0) {
    // A run with no actions is not started: it would write an empty report and
    // teach the user that Execute sometimes does nothing.
    blocking.push({
      text: "Nothing has been decided yet — there is no work to run.",
      tone: "warning",
      messageKey: "preflight.blocking.empty",
    });
  }
  // A stale plan and an unwritable destination are refused by the backend when
  // the run starts (plan fingerprints, destination probe); the exact-impact
  // request above fails for a stale plan. No client-side guess repeats them.
  if (input.requiredBytes === null) {
    blocking.push({
      text: "How much space this run needs is not known yet, so it cannot be checked against the disk.",
      tone: "warning",
      messageKey: "preflight.blocking.spaceUnknown",
    });
  } else if (input.freeBytes !== null && input.freeBytes < input.requiredBytes) {
    blocking.push({
      text: `Not enough free space: ${formatBytes(input.requiredBytes)} needed, ${formatBytes(input.freeBytes)} available.`,
      tone: "error",
      messageKey: "preflight.blocking.space",
      params: {
        required: formatBytes(input.requiredBytes),
        available: formatBytes(input.freeBytes),
      },
    });
  }
  const reversible: PreflightLine[] = [];
  if (input.copyCount > 0) {
    reversible.push({
      text: `${input.copyCount} file(s) copied; the source remains available for re-running.`,
      tone: "neutral",
      messageKey: "preflight.reversible.copy",
      params: { count: input.copyCount },
    });
  }
  const irreversible: PreflightLine[] = [];
  if (input.moveCount > 0) {
    irreversible.push({
      text: `${input.moveCount} source file(s) will be removed only after the destination is verified.`,
      tone: "warning",
      messageKey: "preflight.irreversible.move",
      params: { count: input.moveCount },
    });
  }
  if (input.quarantineCount > 0) {
    irreversible.push({
      text: `${input.quarantineCount} file(s) will be relocated to quarantine (${formatBytes(input.quarantineBytes)}); they are never deleted, but this run does not restore them.`,
      tone: "warning",
      messageKey: "preflight.irreversible.quarantine",
      params: { count: input.quarantineCount, bytes: formatBytes(input.quarantineBytes) },
    });
  }
  if (input.companionsLeftInPlace > 0) {
    irreversible.push({
      text: `${input.companionsLeftInPlace} companion file(s) will remain in the input and their media units will split.`,
      tone: "warning",
      messageKey: "preflight.irreversible.companions",
      params: { count: input.companionsLeftInPlace },
    });
  }
  if (input.embeddedTagCount > 0) {
    irreversible.push({
      text: `Tags will be embedded into up to ${input.embeddedTagCount} file(s), changing their contents.`,
      tone: "warning",
      messageKey: "preflight.irreversible.tags",
      params: { count: input.embeddedTagCount },
    });
  }
  if (irreversible.length === 0) {
    irreversible.push({
      text: "This plan has no effects that remove or rewrite originals.",
      tone: "neutral",
      messageKey: "preflight.irreversible.none",
    });
  }
  if (input.skipCount > 0) {
    reversible.push({
      text: `${input.skipCount} file(s) left exactly where they are.`,
      tone: "neutral",
      messageKey: "preflight.reversible.skip",
      params: { count: input.skipCount },
    });
  }
  if (input.referenceFolders > 0) {
    reversible.push({
      text: `${input.referenceFolders} reference folder(s) are only read, never changed.`,
      tone: "neutral",
      messageKey: "preflight.reversible.reference",
      params: { count: input.referenceFolders },
    });
  }
  if (input.unresolvedFiles > 0) {
    reversible.push({
      text: `${input.unresolvedFiles} file(s) could not be checked for duplicates; this run leaves them where they are.`,
      tone: "warning",
      messageKey: "preflight.reversible.unresolved",
      params: { count: input.unresolvedFiles },
    });
  }
  if (reversible.length === 0) {
    reversible.push({
      text: "No effects in this group.",
      tone: "neutral",
      messageKey: "preflight.reversible.none",
    });
  }

  return {
    canExecute: blocking.length === 0,
    executable: blocking.length === 0 && input.acknowledgedSourceMutations,
    blocking,
    summary: [...reversible, ...irreversible],
    reversible,
    irreversible,
    acknowledgement:
      input.sourceMutations > 0
        ? "I reviewed both groups, including changes to input folders, and want to execute this exact plan"
        : "I reviewed both groups and want to execute this exact plan",
    acknowledgementKey:
      input.sourceMutations > 0 ? "preflight.acknowledge.mutations" : "preflight.acknowledge",
  };
}

// ── Final report ─────────────────────────────────────────────────────────────

export interface ReportView {
  /** Translation key of the headline. */
  headlineKey: string;
  /** Non-zero counts only; each label is a translation key. */
  facts: { labelKey: string; value: number }[];
  /** Translation keys, most urgent first. */
  nextStepKeys: string[];
}

/** What the report says once the run is over — outcomes, not mechanisms. */
export function reportView(operation: OperationSummary): ReportView {
  const counts = operation.counts;
  const facts = [
    { labelKey: "operations.fact.organized", value: counts.verified_success },
    { labelKey: "operations.fact.quarantined", value: counts.quarantined },
    { labelKey: "operations.fact.skipped", value: counts.skipped },
    { labelKey: "operations.fact.warnings", value: counts.warnings },
    { labelKey: "operations.fact.failed", value: counts.failed },
    { labelKey: "operations.fact.needsReview", value: counts.unresolved },
  ].filter((fact) => fact.value !== 0);

  const nextStepKeys: string[] = [];
  if (operation.recoveryState === "required") nextStepKeys.push("operations.next.recovery");
  if (counts.failed > 0) nextStepKeys.push("operations.next.failed");
  if (counts.unresolved > 0) nextStepKeys.push("operations.next.unresolved");
  if (counts.quarantined > 0) nextStepKeys.push("operations.next.quarantined");

  return {
    headlineKey:
      operation.outcome === null
        ? "operations.stillRunning"
        : `report.outcome.${operation.outcome}`,
    facts,
    nextStepKeys,
  };
}
