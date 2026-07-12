/**
 * Cross-platform path helpers.
 *
 * Consolidates the identical `basename`/`getBasename` implementations that were
 * duplicated across PreviewPanel, DuplicateComparison, and MediaPreviewModal.
 * Both Windows (`\`) and POSIX (`/`) separators are handled.
 */

/**
 * Return the final path segment (file or folder name).
 *
 * @param path - a Windows or POSIX path
 * @returns the last segment, or the original string if it has no separators
 *
 * @example
 * getBasename("C:\\Users\\me\\photo.jpg") // "photo.jpg"
 * getBasename("/home/me/photo.jpg") // "photo.jpg"
 */
export function getBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * Front-end mirror of the backend `sanitize_path_segment`, applied as the user
 * types a Smart Categorization category so the chip they see is exactly the
 * folder name that will be created. The backend re-sanitizes and validates; this
 * is the immediate-feedback copy.
 *
 * Strips characters illegal on Windows/POSIX and ASCII control chars, neutralises
 * `..` traversal, collapses whitespace, trims leading/trailing dots & spaces, and
 * caps the length. Returns `""` when nothing safe remains.
 */
export function sanitizeCategory(name: string, maxLength = 64): string {
  return (
    name
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "") // illegal Windows/POSIX + control chars
      .replace(/\.\./g, "") // neutralise parent traversal
      .replace(/\s+/g, " ") // collapse whitespace
      .replace(/^[.\s]+|[.\s]+$/g, "") // strip leading/trailing dots & spaces
      .slice(0, maxLength)
      .replace(/[.\s]+$/g, "")
  );
}
