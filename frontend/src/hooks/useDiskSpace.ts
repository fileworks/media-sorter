import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { DiskSpaceResult } from "@/types/api";
import { useConfig } from "./useConfig";

export function useDiskSpace(): {
  diskSpace: DiskSpaceResult | undefined;
  isInsufficient: boolean;
} {
  const { config } = useConfig();

  const enabled = Boolean(
    config?.copy_instead_of_move &&
    config?.source_directory &&
    config?.target_directory &&
    config?.source_directory !== config?.target_directory,
  );

  const { data } = useQuery({
    queryKey: ["disk-space", config?.source_directory, config?.target_directory],
    queryFn: () => api.getDiskSpace(),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  return {
    diskSpace: data,
    isInsufficient: enabled && data != null && data.sufficient === false,
  };
}
