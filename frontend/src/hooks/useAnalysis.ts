import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { AnalysisResult } from "@/services/api";
import { extractErrorMessage } from "@/lib/errorUtils";

export type { AnalysisResult };

export interface UseAnalysisReturn {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  runAnalysis: () => Promise<void>;
  cancelAnalysis: () => Promise<void>;
  clear: () => void;
}

/** Run analysis through the shared long-operation task transport. */
export function useAnalysis(): UseAnalysisReturn {
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);

  const releaseLoader = useCallback(() => {
    releaseLoaderRef.current?.();
    releaseLoaderRef.current = null;
  }, []);

  const { data: status, error: statusError } = useQuery({
    queryKey: ["analysis", taskId],
    queryFn: () => (taskId ? api.getAnalysisStatus(taskId, lastEventSequenceRef.current) : null),
    enabled: Boolean(taskId && loading),
    refetchInterval: taskId && loading ? 500 : false,
    retry: false,
  });

  useEffect(() => {
    if (!status || handledRef.current) return;
    lastEventSequenceRef.current = Math.max(
      lastEventSequenceRef.current,
      status.last_event_sequence,
    );
    if (status.status === "completed") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      if (status.result) setResult(status.result);
      else setError("Analysis produced no result.");
    } else if (status.status === "failed") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      setError(status.failure?.message ?? status.error ?? "Analysis failed.");
    } else if (status.status === "cancelled") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
    }
  }, [status, releaseLoader]);

  useEffect(() => {
    if (!statusError || handledRef.current) return;
    handledRef.current = true;
    setLoading(false);
    releaseLoader();
    setError(extractErrorMessage(statusError, "Analysis status could not be read."));
  }, [statusError, releaseLoader]);

  useEffect(() => releaseLoader, [releaseLoader]);

  const runAnalysis = useCallback(async () => {
    setTaskId(null);
    void queryClient.removeQueries({ queryKey: ["analysis"] });
    setResult(null);
    setError(null);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    releaseLoaderRef.current = api.beginOperation();
    setLoading(true);
    try {
      setTaskId(await api.startAnalysis());
    } catch (startError) {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      setError(extractErrorMessage(startError, "Analysis failed."));
    }
  }, [queryClient, releaseLoader]);

  const clear = useCallback(() => {
    setTaskId(null);
    setResult(null);
    setError(null);
    setLoading(false);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    void queryClient.removeQueries({ queryKey: ["analysis"] });
  }, [queryClient, releaseLoader]);

  const cancelAnalysis = useCallback(async () => {
    if (!taskId) return;
    try {
      await api.cancelAnalysis(taskId);
    } catch (cancelError) {
      setError(
        extractErrorMessage(
          cancelError,
          "Cancellation could not be requested; analysis is still running.",
        ),
      );
    }
  }, [taskId]);

  return { result, loading, error, runAnalysis, cancelAnalysis, clear };
}
