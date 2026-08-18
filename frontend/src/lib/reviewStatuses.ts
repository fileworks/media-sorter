/**
 * The preview status vocabulary, as a runtime value.
 *
 * A TypeScript union is erased at build time, so the union that used to live
 * inline in `services/api.ts` could not be compared with anything — which is
 * why it was free to drift from the backend. The array below is the same
 * vocabulary as data; `reviewStatuses.test.ts` pins it against
 * `contracts/review-statuses.json`, which the backend generates from
 * `app/core/review_status_contract.py`.
 *
 * Alphabetical, deliberately: it is the artifact's order, so a diff between the
 * two is a diff you can read.
 */
export const PREVIEW_STATUSES = [
  "already_in_destination",
  "duplicate",
  "duplicate_unknown",
  "failed",
  "future_date",
  "junk",
  "keep_in_place",
  "review_only",
  "sort",
  "suspicious_date",
  "unknown_date",
] as const;

export type PreviewItemStatus = (typeof PREVIEW_STATUSES)[number];

/**
 * The statuses that deliberately do *not* send a file to a review folder.
 *
 * Everything else in {@link PREVIEW_STATUSES} carries a review-folder
 * destination and must match the backend's `PLANNED_QUARANTINE_STATUSES`
 * exactly. Listing these four explicitly is what makes a fifth one a deliberate
 * decision rather than silent drift.
 */
export const NON_QUARANTINING_PREVIEW_STATUSES = [
  "duplicate_unknown",
  "keep_in_place",
  "review_only",
  "sort",
] as const satisfies readonly PreviewItemStatus[];
