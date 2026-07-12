import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { AnalysisResult } from "@/services/api";
import { extractErrorMessage } from "@/lib/errorUtils";

export type { AnalysisResult };

export interface UseAnalysisReturn {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  runAnalysis: () => Promise<void>;
  clear: () => void;
}

/**
 * Run a source-directory analysis on demand.
 *
 * Backed by a React Query mutation (rather than manual `useState`) so it shares
 * the same loading/error/cache semantics as the other data hooks. The public
 * shape is unchanged so callers need no updates.
 */
export function useAnalysis(): UseAnalysisReturn {
  const { mutateAsync, reset, data, isPending, error } = useMutation({
    mutationFn: () => api.analyse(),
  });

  const runAnalysis = useCallback(async () => {
    try {
      await mutateAsync();
    } catch {
      // The failure is surfaced via `error` below; swallow here so callers can
      // `await runAnalysis()` without it throwing.
    }
  }, [mutateAsync]);

  const clear = useCallback(() => reset(), [reset]);

  return {
    result: data ?? null,
    loading: isPending,
    error: error ? extractErrorMessage(error, "Analysis failed") : null,
    runAnalysis,
    clear,
  };
}
