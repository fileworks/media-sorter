import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { ConfigSectionMeta } from "@/types/api";

/**
 * Fetches the shared config-section grouping (labels + descriptions) from the
 * backend so the configure screen's rail and per-section help read the same
 * definition the backend owns. Cached aggressively
 * — the grouping is effectively static. Callers pair this with a built-in
 * fallback so the panel still renders instantly / offline.
 */
export function useConfigSections(): Map<string, ConfigSectionMeta> {
  const { data } = useQuery({
    queryKey: ["config", "sections"],
    queryFn: () => api.getConfigSections(),
    staleTime: Infinity,
    retry: 1,
  });

  return new Map((data ?? []).map((section) => [section.id, section]));
}
