/**
 * Centralised extraction of a human-readable message from an unknown thrown
 * value. Replaces the fragile inline `(err as {...}).response?.data?.error`
 * casts that were duplicated across the async hooks.
 *
 * Resolution order (most specific → least):
 *  1. The backend error envelope `response.data.error` (FastAPI's
 *     `{ error, code, details }` shape). Preferred over the generic Axios
 *     `Error.message` ("Request failed with status code 500") because it carries
 *     the real, user-facing reason.
 *  2. A native `Error.message` (network failures, aborts, thrown Errors).
 *  3. `defaultMessage` when nothing usable is found.
 *
 * @param err - the caught value (typed `unknown`, as in a `catch`)
 * @param defaultMessage - fallback when no message can be extracted
 * @returns a non-empty, displayable message string
 */
export function extractErrorMessage(err: unknown, defaultMessage = "Unknown error"): string {
  if (typeof err === "object" && err !== null) {
    const envelope = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
    if (typeof envelope === "string" && envelope.trim() !== "") {
      return envelope;
    }
  }

  if (err instanceof Error && err.message.trim() !== "") {
    return err.message;
  }

  return defaultMessage;
}
