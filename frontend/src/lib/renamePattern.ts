/**
 * Rename-pattern helpers — the pure logic behind the Configure screen's
 * "Rename files" builder. Kept here, framework-free
 * and unit-tested, alongside the other `src/lib` formatters.
 *
 * A pattern is a filename template built from literal text and these variables:
 *   YYYY (year) · MM (month) · DD (day) · NAME (original stem) · TYPE (IMG/VID).
 * The backend (`SortingService._apply_rename`) substitutes the same tokens with
 * a single anywhere-pass, so any non-token text is treated as a literal.
 */

/** A recognised rename variable, with the value it expands to in the live example. */
export interface RenameToken {
  token: string;
  label: string;
  example: string;
}

export const RENAME_TOKENS: readonly RenameToken[] = [
  { token: "YYYY", label: "Year (4 digits)", example: "2024" },
  { token: "MM", label: "Month", example: "03" },
  { token: "DD", label: "Day", example: "15" },
  { token: "NAME", label: "Original filename", example: "IMG_001" },
  { token: "TYPE", label: "File type — IMG or VID", example: "IMG" },
] as const;

// Tokens ordered longest-first so the regex never matches a prefix of a longer
// token (here all are distinct, but this keeps it robust if tokens are added).
const TOKEN_RE = /YYYY|MM|DD|NAME|TYPE/g;

/**
 * Validate a rename pattern for the UI. Returns at most one of `error`
 * (blocking) or `warning` (advisory); an empty object means "fine".
 */
export function validateRenamePattern(pattern: string): { error?: string; warning?: string } {
  if (!pattern) return { error: "Enter a pattern." };
  if (pattern.includes("/") || pattern.includes("\\"))
    return { error: "A pattern can't contain slashes." };
  const hasVar = RENAME_TOKENS.some((t) => pattern.includes(t.token));
  if (!hasVar) return { warning: "No variables — every file would get the same name." };
  return {};
}

/** A resolved segment of a rendered pattern, tagged token-derived or literal. */
export interface PatternPart {
  text: string;
  isToken: boolean;
}

/**
 * Resolve *pattern* for an example file, returning segments tagged as token-
 * derived or literal so the preview can highlight which characters came from a
 * variable. The trailing `ext` (e.g. `.jpg`) is appended as a literal.
 */
export function renderPatternParts(
  pattern: string,
  date: Date,
  originalName: string,
  ext: string,
  type: "IMG" | "VID",
): PatternPart[] {
  // JavaScript months are 0-indexed (Jan=0); the user-facing token is 1-indexed.
  const tokenMap: Record<string, string> = {
    YYYY: date.getFullYear().toString(),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(date.getDate()).padStart(2, "0"),
    NAME: originalName,
    TYPE: type,
  };
  const parts: PatternPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively — TOKEN_RE is a shared global-flag regex.
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(pattern)) !== null) {
    if (m.index > last) parts.push({ text: pattern.slice(last, m.index), isToken: false });
    parts.push({ text: tokenMap[m[0]], isToken: true });
    last = m.index + m[0].length;
  }
  if (last < pattern.length) parts.push({ text: pattern.slice(last), isToken: false });
  if (ext) parts.push({ text: ext, isToken: false });
  return parts;
}

/** Flatten rendered parts into the plain resolved filename. */
export function renderPattern(
  pattern: string,
  date: Date,
  originalName: string,
  ext: string,
  type: "IMG" | "VID",
): string {
  return renderPatternParts(pattern, date, originalName, ext, type)
    .map((p) => p.text)
    .join("");
}
