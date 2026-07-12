import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { HardwareInfo } from "@/types/api";

/**
 * The machine's AI-relevant hardware profile. Probed once on the backend, so it
 * never changes within a session — cached effectively forever client-side.
 */
export function useHardware() {
  const { data, isLoading } = useQuery<HardwareInfo>({
    queryKey: ["hardware"],
    queryFn: () => api.getHardware(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return { hardware: data, isLoading };
}
