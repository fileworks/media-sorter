import { useQuery } from "@tanstack/react-query";

import { api, type MediaInfo, type ReviewOutcome } from "@/services/api";

/**
 * Resolution, size and date for one file, from `GET /api/media/info`.
 *
 * Per-file, never per-row: the list draws forty thousand rows and a request on
 * each of them is not a list. The detail view opens on exactly one file at a
 * time, which is the only place this cost is affordable — and it is the reason
 * `ReviewRow` no longer carries `width` and `height` at all. They were hardcoded
 * `null` on every row, which is worse than an absent field: a caller reading a
 * resolution would have got "unknown" for a file whose resolution is known.
 */
export function useMediaInfo(path: string | null) {
  return useQuery<MediaInfo>({
    queryKey: ["media", "info", path],
    queryFn: () => api.getMediaInfo(path as string),
    enabled: path !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * What the last completed preview recorded about the complete planned outcome.
 *
 * The endpoint has had no caller since the Review rework removed the inspector,
 * and it answers the question a row's derived reason can only summarise: which
 * candidate dates existed, which one won, and why each of the others was
 * rejected. Asked for one file, when that file is open.
 *
 * A 409 means the configuration moved after the preview — the answer would
 * describe a plan that no longer exists, so it has a named state rather than
 * looking like a file for which no reasoning was recorded.
 */
export type ReviewOutcomeLookup =
  | { state: "available"; outcome: ReviewOutcome }
  | { state: "unavailable" }
  | { state: "superseded" };

function responseStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : null;
}

export function useReviewOutcome(path: string | null) {
  return useQuery<ReviewOutcomeLookup>({
    queryKey: ["review", "outcome", path],
    queryFn: async () => {
      try {
        const outcomes = await api.reviewOutcomes([path as string]);
        const outcome = outcomes.outcomes[0];
        return outcome === undefined
          ? { state: "unavailable" as const }
          : { state: "available" as const, outcome };
      } catch (error) {
        if (responseStatus(error) === 409) return { state: "superseded" as const };
        if (responseStatus(error) === 404) return { state: "unavailable" as const };
        throw error;
      }
    },
    enabled: path !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
