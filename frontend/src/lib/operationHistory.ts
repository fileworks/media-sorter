/**
 * The audit a user can actually act on, without opening a log file.
 *
 * History entries are bounded, filterable, and carry the counts that decide
 * what to do next — plus the identifiers needed to reach the report, the
 * quarantine, and the correlated log lines. Roots are shown redacted by default
 * because a history list is the thing most likely to end up in a screenshot.
 */

import type { OperationOutcome } from "./statusPresentation";

export interface HistoryEntry {
  operation_id: string;
  profile_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: OperationOutcome | null;
  roots: string[];
  counts: {
    verified_success: number;
    warnings: number;
    skipped: number;
    quarantined: number;
    failed: number;
    unresolved: number;
  };
  bytes_written: number;
  report_id: string | null;
  recovery_state: "none" | "available" | "required";
}

/** How many entries are kept in memory and on screen. */
export const HISTORY_LIMIT = 200;

export type HistoryFilter = "all" | "problems" | "recovery" | "running";

export function filterHistory(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  switch (filter) {
    case "problems":
      return entries.filter(
        (entry) =>
          entry.counts.failed > 0 || entry.counts.unresolved > 0 || entry.outcome === "failed",
      );
    case "recovery":
      return entries.filter((entry) => entry.recovery_state !== "none");
    case "running":
      return entries.filter((entry) => entry.outcome === null);
    default:
      return entries;
  }
}

/** Newest first, then bounded — the order a user reads it in. */
export function boundHistory(entries: HistoryEntry[], limit = HISTORY_LIMIT): HistoryEntry[] {
  return [...entries]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, limit);
}

export interface HistorySummary {
  headline: string;
  /** The counts worth reading, already dropped when zero. */
  facts: { label: string; value: number }[];
  nextSteps: string[];
  /** Ids the row links to; empty when there is nothing to open. */
  links: { kind: "report" | "quarantine" | "logs"; id: string }[];
}

export function summarizeEntry(entry: HistoryEntry): HistorySummary {
  const facts = [
    { label: "Organized", value: entry.counts.verified_success },
    { label: "Warnings", value: entry.counts.warnings },
    { label: "Skipped", value: entry.counts.skipped },
    { label: "Quarantined", value: entry.counts.quarantined },
    { label: "Failed", value: entry.counts.failed },
    { label: "Needs review", value: entry.counts.unresolved },
  ].filter((fact) => fact.value > 0);

  const nextSteps: string[] = [];
  if (entry.recovery_state === "required") {
    nextSteps.push("Finish reviewing the interrupted operation before starting another run.");
  }
  if (entry.counts.unresolved > 0) {
    nextSteps.push("Open the report to decide what happens to the unresolved files.");
  }
  if (entry.counts.quarantined > 0) {
    nextSteps.push("Quarantined originals are still there — nothing was deleted.");
  }
  if (entry.counts.failed > 0 && nextSteps.length === 0) {
    nextSteps.push("Check the failed files; their sources were left untouched.");
  }

  const links: HistorySummary["links"] = [];
  if (entry.report_id) links.push({ kind: "report", id: entry.report_id });
  if (entry.counts.quarantined > 0) links.push({ kind: "quarantine", id: entry.operation_id });
  links.push({ kind: "logs", id: entry.operation_id });

  return {
    headline:
      entry.outcome === null
        ? "Running"
        : entry.outcome === "completed"
          ? "Finished"
          : entry.outcome.replace(/_/g, " "),
    facts,
    nextSteps,
    links,
  };
}

export function totalBytes(entries: HistoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes_written, 0);
}
