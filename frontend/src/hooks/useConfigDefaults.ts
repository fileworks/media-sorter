import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { Config } from "@/types/api";

/**
 * The factory-default config, fetched from the backend so "deviates from
 * default" detection is always accurate (no client-side mirror to drift). The
 * defaults are immutable for a given build → cached for the whole session.
 */
export function useConfigDefaults() {
  const { data } = useQuery<Partial<Config>>({
    queryKey: ["config", "defaults"],
    queryFn: () => api.getConfigDefaults(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
