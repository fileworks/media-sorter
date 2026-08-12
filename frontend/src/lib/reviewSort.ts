/**
 * One ordering, read by every list on the Review screen.
 *
 * Browse, the duplicate queue and the copies inside one set are three renderings
 * of the same rows, so they cannot each have their own idea of "sorted" — a
 * reader who puts the largest file first in the browser and then opens a set
 * expects the largest copy first there too. The control is duplicated in both
 * toolbars because both are reachable without the other; the *state* is not.
 *
 * Pure and DOM-free: the comparator is the part worth testing, and it should be
 * testable without mounting a virtualised list.
 */

import type { BrowseEntry, SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

export type ReviewSort = "name" | "size" | "date";

export const REVIEW_SORTS: readonly ReviewSort[] = ["name", "size", "date"] as const;

export function isReviewSort(value: string): value is ReviewSort {
  return (REVIEW_SORTS as readonly string[]).includes(value);
}

/** What a comparison actually reads, whatever kind of thing it was built from. */
export interface SortModel {
  name: string;
  /** Bytes. A set contributes its largest copy — that is what it "weighs". */
  size: number;
  /**
   * The recorded date, kept as the string the plan carries. These are ISO-ish
   * and so sort correctly as text; parsing them to a number here would invent
   * a timezone the plan never claimed. An empty string is "no date", and sorts
   * last under a newest-first order.
   */
  date: string;
}

export function rowSortModel(row: ReviewRow): SortModel {
  return { name: row.name, size: row.sizeBytes, date: row.date ?? "" };
}

export function setSortModel(entry: SetEntry): SortModel {
  const rows = entry.rows;
  const lead = entry.keeper ?? rows[0] ?? null;
  return {
    name: lead?.name ?? entry.id,
    size: rows.reduce((largest, row) => Math.max(largest, row.sizeBytes), 0),
    date: rows.reduce(
      (latest, row) => (row.date !== null && row.date > latest ? row.date : latest),
      "",
    ),
  };
}

export function entrySortModel(entry: BrowseEntry): SortModel {
  return entry.kind === "file" ? rowSortModel(entry.row) : setSortModel(entry);
}

/**
 * Name is ascending; size and date are descending, because "sort by size" is
 * never a request to see the smallest thing first. Ties fall back to the name
 * so the order is total — an unstable tail is what makes a list appear to
 * reshuffle itself when a single decision changes one row.
 */
export function compareBySort(
  a: SortModel,
  b: SortModel,
  sort: ReviewSort,
  locale: string,
): number {
  const byName = () => a.name.localeCompare(b.name, locale, { sensitivity: "base" });
  if (sort === "name") return byName();
  if (sort === "size") return b.size - a.size || byName();
  // "" is no date, and belongs at the end rather than at the top of a
  // newest-first list, so it is compared as if it were older than everything.
  if (a.date === b.date) return byName();
  if (a.date === "") return 1;
  if (b.date === "") return -1;
  return a.date < b.date ? 1 : -1;
}

export function sortEntries(
  entries: readonly BrowseEntry[],
  sort: ReviewSort,
  locale: string,
): BrowseEntry[] {
  return [...entries].sort((left, right) =>
    compareBySort(entrySortModel(left), entrySortModel(right), sort, locale),
  );
}

export function sortRows(
  rows: readonly ReviewRow[],
  sort: ReviewSort,
  locale: string,
): ReviewRow[] {
  return [...rows].sort((left, right) =>
    compareBySort(rowSortModel(left), rowSortModel(right), sort, locale),
  );
}

export function sortSets(sets: readonly SetEntry[], sort: ReviewSort, locale: string): SetEntry[] {
  return [...sets].sort((left, right) =>
    compareBySort(setSortModel(left), setSortModel(right), sort, locale),
  );
}
