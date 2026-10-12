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
