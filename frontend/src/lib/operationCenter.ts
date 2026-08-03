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
  bytesWritten: number;
  reportId: string | null;
  recoveryState: "none" | "available" | "required";
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
  title: string;
}

export function centerBadge(state: CenterState): CenterBadge {
  if (state.active) {
    return { count: 1, tone: "info", title: `${state.active.kind} in progress` };
  }
  const needsAttention = state.recent.filter(
    (operation) => operation.recoveryState === "required" || operation.counts.failed > 0,
  );
  if (needsAttention.length > 0) {
    return {
      count: needsAttention.length,
      tone: "error",
      title: `${needsAttention.length} operation(s) need attention`,
    };
  }
  if (state.unread.length > 0) {
    return { count: state.unread.length, tone: "warning", title: "Finished with warnings" };
  }
  return { count: 0, tone: "neutral", title: "Nothing running" };
}

// ── Execute preflight ────────────────────────────────────────────────────────

export interface PreflightInput {
  /** Groups whose decisions would run. */
  actionableGroups: number;
  /**
   * Files Review took out of this run. Distinguishes "you have not decided
   * anything yet" from "you decided to leave everything out" — two states that
   * both count zero and need opposite advice.
   */
  excludedCount?: number;
  quarantineCount: number;
  quarantineBytes: number;
  copyCount: number;
  moveCount: number;
  skipCount: number;
  referenceCount: number;
  /** Actions that change an input folder under Copy mode. */
  sourceMutations: number;
  acknowledgedSourceMutations: boolean;
  staleGroups: number;
  unresolvedGroups: number;
  /** Outcomes preview could not freeze safely; the whole sort must be reviewed again. */
  unplannedCount?: number;
  freeBytes: number | null;
  requiredBytes: number;
  quarantineWritable: boolean;
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
  canExecute: boolean;
  blocking: PreflightLine[];
  summary: PreflightLine[];
  reversible: PreflightLine[];
  irreversible: PreflightLine[];
  /** Shown when the user must tick something before the button enables. */
  acknowledgement: string | null;
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

  if (input.actionableGroups === 0) {
    // A run with no actions is not started: it would write an empty report and
    // teach the user that Execute sometimes does nothing. What the message must
    // not do is misdiagnose a deliberate "exclude everything" as indecision.
    blocking.push(
      (input.excludedCount ?? 0) > 0
        ? {
            text: "Every file is excluded, so this run would do nothing.",
            tone: "warning",
            messageKey: "preflight.blocking.allExcluded",
            params: { count: input.excludedCount ?? 0 },
          }
        : {
            text: "Nothing has been decided yet — there is no work to run.",
            tone: "warning",
            messageKey: "preflight.blocking.empty",
          },
    );
  }
  if (input.staleGroups > 0) {
    blocking.push({
      text: `${input.staleGroups} group(s) changed since you reviewed them and must be looked at again.`,
      tone: "error",
      messageKey: "preflight.blocking.stale",
      params: { count: input.staleGroups },
    });
  }
  if ((input.unplannedCount ?? 0) > 0) {
    blocking.push({
      text: `${input.unplannedCount} outcome(s) could not be frozen safely; review the plan again before executing.`,
      tone: "error",
      messageKey: "preflight.blocking.unplanned",
      params: { count: input.unplannedCount ?? 0 },
    });
  }
  if (!input.quarantineWritable) {
    blocking.push({
      text: "Quarantine is not writable, so nothing can be moved safely.",
      tone: "error",
      messageKey: "preflight.blocking.quarantine",
    });
  }
  if (input.freeBytes !== null && input.freeBytes < input.requiredBytes) {
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
  if (input.conversionWithoutOriginals > 0) {
    irreversible.push({
      text: `${input.conversionWithoutOriginals} original file(s) will not be retained after conversion.`,
      tone: "warning",
      messageKey: "preflight.irreversible.conversion",
      params: { count: input.conversionWithoutOriginals },
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
  if (input.referenceCount > 0) {
    reversible.push({
      text: `${input.referenceCount} reference file(s) will not be touched.`,
      tone: "neutral",
      messageKey: "preflight.reversible.reference",
      params: { count: input.referenceCount },
    });
  }
  if (input.unresolvedGroups > 0) {
    reversible.push({
      text: `${input.unresolvedGroups} group(s) are still unresolved and are not part of this run.`,
      tone: "warning",
      messageKey: "preflight.reversible.unresolved",
      params: { count: input.unresolvedGroups },
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
    canExecute:
      blocking.length === 0 && (input.sourceMutations === 0 || input.acknowledgedSourceMutations),
    blocking,
    summary: [...reversible, ...irreversible],
    reversible,
    irreversible,
    acknowledgement: input.acknowledgedSourceMutations
      ? null
      : input.sourceMutations > 0
        ? "I reviewed both groups, including changes to input folders, and want to execute this exact plan"
        : "I reviewed both groups and want to execute this exact plan",
  };
}

// ── Final report ─────────────────────────────────────────────────────────────

export interface ReportView {
  headline: string;
  facts: { label: string; value: string }[];
  nextSteps: string[];
  links: { kind: "report" | "quarantine" | "logs" | "recovery"; id: string }[];
}

/** What the report says once the run is over — outcomes, not mechanisms. */
export function reportView(operation: OperationSummary): ReportView {
  const counts = operation.counts;
  const facts = [
    { label: "Organized", value: counts.verified_success.toLocaleString() },
    { label: "Quarantined", value: counts.quarantined.toLocaleString() },
    { label: "Skipped", value: counts.skipped.toLocaleString() },
    { label: "Warnings", value: counts.warnings.toLocaleString() },
    { label: "Failed", value: counts.failed.toLocaleString() },
    { label: "Needs review", value: counts.unresolved.toLocaleString() },
  ].filter((fact) => fact.value !== "0");

  const nextSteps: string[] = [];
  if (counts.quarantined > 0) {
    nextSteps.push("Quarantined originals are still there — nothing was deleted.");
  }
  if (counts.unresolved > 0) {
    nextSteps.push("Some files need a decision before this run is complete.");
  }
  if (counts.failed > 0) {
    nextSteps.push("Failed actions left their sources untouched; the report says why.");
  }
  if (operation.recoveryState === "required") {
    nextSteps.push("Finish reviewing the interrupted operation before starting another.");
  }

  const links: ReportView["links"] = [];
  if (operation.reportId) links.push({ kind: "report", id: operation.reportId });
  if (counts.quarantined > 0) links.push({ kind: "quarantine", id: operation.operationId });
  if (operation.recoveryState !== "none") {
    links.push({ kind: "recovery", id: operation.operationId });
  }
  links.push({ kind: "logs", id: operation.operationId });

  return {
    headline:
      operation.outcome === null
        ? "Still running"
        : operation.outcome === "completed"
          ? "Finished"
          : operation.outcome.replace(/_/g, " "),
    facts,
    nextSteps,
    links,
  };
}
