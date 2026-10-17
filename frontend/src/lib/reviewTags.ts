/** Review's content-tag edits: the same bounds and cleaning the backend applies. */

/** Mirrors the backend's bounds for Review's tag edits. */
export const MAX_REVIEWED_TAGS = 50;
export const MAX_REVIEWED_TAG_LENGTH = 100;

/** Trimmed, case-insensitively unique tags; the same rule the backend applies. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.split(/\s+/).filter(Boolean).join(" ");
    const key = tag.toLocaleLowerCase();
    if (tag === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * The content tags Review offers to edit for a row; `null` hides the editor.
 *
 * A copy set aside under `_copies/` is never tagged by a run, so offering its
 * proposal as "tags the run will write" would be false. Its proposal stays in
 * the plan: choosing it as the keeper later makes it editable again.
 */
export function editableAiTags(
  row: { source: string; status: string; aiTags: string[] | null },
  edits: ReadonlyMap<string, string[]>,
): string[] | null {
  if (row.status === "duplicate" || row.aiTags === null) return null;
  return edits.get(row.source) ?? row.aiTags;
}
