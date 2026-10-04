import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { UpdateInfo } from "@/services/api";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function useUpdateCheck(enabled = true): {
  data: UpdateInfo | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery<UpdateInfo>({
    queryKey: ["update"],
    queryFn: () => api.checkUpdate(),
    enabled,
    staleTime: SIX_HOURS,
    refetchInterval: SIX_HOURS,
    retry: 1,
    // Never throw — the backend is best-effort; failure just means no banner.
    throwOnError: false,
  });

  return { data: enabled ? data : undefined, isLoading };
}
