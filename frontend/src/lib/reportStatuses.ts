/**
 * How an executed file's status maps onto the report's filter tabs.
 *
 * The report screen used to hold this twice: `FILTER_TABS` decided which rows a
 * tab showed, and a separate if/else chain decided the number on the tab. Two
 * lists of the same strings in one file is one list too many, so both now read
 * this one.
 *
 * The relation is pinned against `contracts/review-statuses.json` in
 * `__tests__/reportStatuses.test.ts`. Every status the executor writes must be
 * in exactly one tab or explicitly unfiltered below — otherwise a row is
 * counted in "All" and reachable from no tab, which is how
 * `companion_left_in_place` and `kept_in_place` became invisible, and how
 * `unmatched_companion` came to be filtered for despite never being written.
 */

export type ReportFilterTab = "all" | "sorted" | "quarantined" | "duplicates" | "failed";

export const REPORT_FILTER_TABS: readonly {
  id: ReportFilterTab;
  /** `null` means "no status filter" — the "all" tab. */
  statuses: readonly string[] | null;
}[] = [
  { id: "all", statuses: null },
  { id: "sorted", statuses: ["success"] },
  { id: "quarantined", statuses: ["unknown_date", "future_date", "corrupted", "junk"] },
  { id: "duplicates", statuses: ["duplicate", "already_in_destination"] },
  { id: "failed", statuses: ["failed", "incomplete_unit", "cancelled", "blocked"] },
];

/**
 * Successful outcomes in which nothing was transferred.
 *
 * They are deliberately in no tab: "Sorted" would misreport them as moved, and
 * "Failed" is plainly wrong. They remain visible under "All". Giving them a tab
 * of their own is a product decision, not a bug fix — this list exists so the
 * omission is stated rather than accidental.
 */
export const UNFILTERED_RECORD_STATUSES: readonly string[] = [
  "kept_in_place",
  "companion_left_in_place",
];

/** The tab a status belongs to, or `null` when it is deliberately unfiltered. */
export function reportTabForStatus(status: string): ReportFilterTab | null {
  for (const tab of REPORT_FILTER_TABS) {
    if (tab.statuses?.includes(status)) return tab.id;
  }
  return null;
}
