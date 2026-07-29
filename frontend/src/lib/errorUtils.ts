/**
 * Centralised extraction of a human-readable message from an unknown thrown
 * value. Replaces the fragile inline `(err as {...}).response?.data?.error`
 * casts that were duplicated across the async hooks.
 *
 * Resolution order (most specific → least):
 *  1. A structured backend error (`response.data.error` or FastAPI
 *     `response.data.detail`). Preferred over the generic Axios
 *     `Error.message` ("Request failed with status code 500") because it carries
 *     the real, user-facing reason.
 *  2. `defaultMessage` for native/unstructured errors. Their implementation
 *     messages are useful in logs, but are not an interface contract.
 *
 * @param err - the caught value (typed `unknown`, as in a `catch`)
 * @param defaultMessage - fallback when no message can be extracted
 * @returns a non-empty, displayable message string
 */
export function extractErrorMessage(err: unknown, defaultMessage = "Unknown error"): string {
  if (typeof err === "object" && err !== null) {
    const data = (
      err as {
        response?: { data?: { error?: unknown; detail?: unknown } };
      }
    ).response?.data;
    const structured = data?.error ?? data?.detail;
    if (typeof structured === "string" && structured.trim() !== "") {
      return userFacingError(structured);
    }
  }

  return userFacingError(defaultMessage);
}

/** Remove implementation detail before an already-captured error reaches UI. */
export function userFacingError(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "The operation could not be completed.";
  if (
    /traceback|stack trace|(?:^|\n)\s*at\s|file ".*", line \d+|node_modules|sql(?:ite)? error|^[A-Z][A-Za-z]+Error:/i.test(
      value,
    )
  ) {
    return "The operation could not be completed. Try again or check the operation log.";
  }
  return firstLine.slice(0, 320);
}
