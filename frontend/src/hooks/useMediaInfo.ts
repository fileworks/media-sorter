import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { MediaInfo } from "@/types/api";

/**
 * Fetch resolution / size / date metadata for a local file. Cached by path so
 * the hover card, preview modal, and duplicate comparison all share one request
 * per file. Pass `enabled: false` to defer the fetch (e.g. until a card is shown).
 */
export function useMediaInfo(path: string | null | undefined, enabled = true) {
  return useQuery<MediaInfo>({
    queryKey: ["mediaInfo", path],
    queryFn: () => api.getMediaInfo(path!),
    enabled: enabled && !!path,
    staleTime: 5 * 60_000,
  });
}

/** Format a resolution as e.g. "4032 × 3024", or "—" when unknown. */
export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!width || !height) return "—";
  return `${width.toLocaleString()} × ${height.toLocaleString()}`;
}
