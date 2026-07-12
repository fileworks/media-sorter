import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/services/api";
import type { OperationReport, OperationListResponse } from "@/types/api";

export function useReportHistory(limit = 20, offset = 0) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<OperationListResponse>({
    queryKey: ["reports", limit, offset],
    queryFn: () => api.listReports(limit, offset),
    staleTime: 30_000,
  });

  const fetchReport = useCallback(
    async (operationId: string): Promise<OperationReport> => {
      const cached = queryClient.getQueryData<OperationReport>(["report", operationId]);
      if (cached) return cached;
      const fresh = await api.getReport(operationId);
      queryClient.setQueryData(["report", operationId], fresh);
      return fresh;
    },
    [queryClient],
  );

  return {
    operations: data?.operations ?? [],
    total: data?.total ?? 0,
    isLoading,
    error,
    refetch,
    fetchReport,
  };
}
