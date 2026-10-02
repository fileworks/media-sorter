/**
 * The one order every fact list is read in.
 *
 * Details and Compare described the same file with the same facts in two
 * different orders — Details led with the file type and resolution, Compare
 * with the capture date — and three facts carried two label keys each, so
 * "Media unit" and "Media unit" were separate strings that could drift apart.
 * Comparing two copies means reading one list twice; a reader should not have
 * to find each row again in a new place.
 *
 * Both surfaces build their own rows and hand them to {@link orderFacts},
 * which is the only thing that decides sequence. A fact absent from a surface
 * is simply skipped: the order of what remains still matches.
 */
export const REVIEW_FACT_ORDER = [
  "fileType",
  "resolution",
  "megapixels",
  "duration",
  "codec",
  "size",
  "date",
  "source",
  "destination",
  "result",
  "reason",
  "category",
  "tags",
  "confidence",
  "protection",
  "mediaUnit",
  "companions",
  "unitWarnings",
  "set",
] as const;

export type ReviewFactId = (typeof REVIEW_FACT_ORDER)[number];

/** The label key each fact is titled with, on every surface that shows it. */
export const REVIEW_FACT_LABELS: Record<ReviewFactId, string> = {
  fileType: "review.detail.fileType",
  resolution: "review.column.resolution",
  megapixels: "review.column.megapixels",
  duration: "review.detail.duration",
  codec: "review.detail.codec",
  size: "review.column.size",
  date: "review.column.date",
  source: "review.detail.source",
  destination: "review.detail.destination",
  result: "review.detail.result",
  reason: "review.detail.reason",
  category: "review.detail.category",
  tags: "review.detail.tags",
  confidence: "review.column.evidence",
  protection: "review.detail.protection",
  mediaUnit: "review.detail.mediaUnitLabel",
  companions: "review.detail.companions",
  unitWarnings: "review.compare.unitWarnings",
  set: "review.detail.set",
};

const INDEX = new Map<ReviewFactId, number>(
  REVIEW_FACT_ORDER.map((id, position) => [id, position]),
);

/** The facts a surface has, in the canonical order. Unknown ids are dropped. */
export function orderFacts<T extends { id: ReviewFactId }>(facts: readonly (T | null)[]): T[] {
  return facts
    .filter((fact): fact is T => fact !== null && INDEX.has(fact.id))
    .sort((left, right) => (INDEX.get(left.id) ?? 0) - (INDEX.get(right.id) ?? 0));
}
