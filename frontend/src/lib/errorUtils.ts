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
 * The backend's envelope also carries a stable `code`. It is returned beside the
 * message rather than folded into it, so the interface can show the identifier
 * a bug report needs without putting it in the sentence a person reads.
 *
 * @param err - the caught value (typed `unknown`, as in a `catch`)
 * @param defaultMessage - fallback when no message can be extracted
 * @returns a displayable message, plus the envelope's code and details if present
 */
export interface ExtractedError {
  /** Non-empty and safe to display. */
  message: string;
  /** The envelope's stable identifier, absent for native or unstructured errors. */
  code?: string;
  /** Whatever the envelope attached; shape is endpoint-specific. */
  details?: unknown;
}

export function extractErrorMessage(
  err: unknown,
  defaultMessage = "Unknown error",
): ExtractedError {
  if (typeof err === "object" && err !== null) {
    const data = (
      err as {
        response?: {
          data?: { error?: unknown; detail?: unknown; code?: unknown; details?: unknown };
        };
      }
    ).response?.data;
    const structured = data?.error ?? data?.detail;
    const code =
      typeof data?.code === "string" && data.code.trim() !== "" ? data.code.trim() : undefined;
    if (typeof structured === "string" && structured.trim() !== "") {
      return { message: userFacingError(structured), code, details: data?.details };
    }
    if (code !== undefined) {
      return { message: userFacingError(defaultMessage), code, details: data?.details };
    }
  }

  return { message: userFacingError(defaultMessage) };
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
