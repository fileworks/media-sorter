import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { AnalysisResult } from "@/services/api";
import type { TaskProgress } from "@/types/api";
import { extractErrorMessage, userFacingError, type ExtractedError } from "@/lib/errorUtils";
import { useI18n } from "@/i18n/I18nContext";

export type { AnalysisResult };

export interface UseAnalysisReturn {
  result: AnalysisResult | null;
  loading: boolean;
  error: ExtractedError | null;
  cancelled: boolean;
  elapsed: number;
  progress: TaskProgress | null;
  /** Resolves with the scan when it finishes, or null if it failed or was cancelled. */
  runAnalysis: (excludedRoots?: string[]) => Promise<AnalysisResult | null>;
  cancelAnalysis: () => Promise<void>;
  clear: () => void;
}

/** Run analysis through the shared long-operation task transport. */
export function useAnalysis(): UseAnalysisReturn {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ExtractedError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);
  // `runAnalysis` starts a background task and returns; completion arrives
  // later, by polling. Callers that need to do something *after* the scan —
  // the dry run does, and the backend rejects a second operation while one is
  // running — get this promise instead of a resolved one.
  const settleRef = useRef<((result: AnalysisResult | null) => void) | null>(null);

  const settle = useCallback((value: AnalysisResult | null) => {
    settleRef.current?.(value);
    settleRef.current = null;
  }, []);

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
    if (!loading) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (!status || handledRef.current) return;
    lastEventSequenceRef.current = Math.max(
      lastEventSequenceRef.current,
      status.last_event_sequence,
    );
    if (status.status === "completed") {
      handledRef.current = true;
      setLoading(false);
      setCancelled(false);
      setError(null);
      releaseLoader();
      if (status.result) setResult(status.result);
      else setError({ message: t("analysis.noResult"), code: "ANALYSIS_NO_RESULT" });
      settle(status.result ?? null);
    } else if (status.status === "failed") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      setError({
        message: userFacingError(status.failure?.message ?? status.error ?? t("analysis.failed")),
        code: status.failure?.code ?? "ANALYSIS_FAILED",
      });
      settle(null);
    } else if (status.status === "cancelled") {
      handledRef.current = true;
      setLoading(false);
      setError(null);
      releaseLoader();
      setCancelled(true);
      settle(null);
    }
  }, [status, releaseLoader, settle, t]);

  useEffect(() => {
    if (!statusError || handledRef.current) return;
    handledRef.current = true;
    setLoading(false);
    releaseLoader();
    const extracted = extractErrorMessage(statusError, t("analysis.statusFailed"));
    setError({ ...extracted, code: extracted.code ?? "ANALYSIS_STATUS_UNAVAILABLE" });
    settle(null);
  }, [statusError, releaseLoader, settle, t]);

  useEffect(
    () => () => {
      releaseLoader();
      settle(null);
    },
    [releaseLoader, settle],
  );

  const runAnalysis = useCallback(
    async (excludedRoots: string[] = []): Promise<AnalysisResult | null> => {
      settle(null);
      setTaskId(null);
      void queryClient.removeQueries({ queryKey: ["analysis"] });
      setResult(null);
      setError(null);
      setCancelled(false);
      setElapsed(0);
      handledRef.current = false;
      lastEventSequenceRef.current = 0;
      releaseLoader();
      releaseLoaderRef.current = api.beginOperation();
      setLoading(true);
      const settled = new Promise<AnalysisResult | null>((resolve) => {
        settleRef.current = resolve;
      });
      try {
        setTaskId(await api.startAnalysis(excludedRoots));
      } catch (startError) {
        handledRef.current = true;
        setLoading(false);
        releaseLoader();
        const extracted = extractErrorMessage(startError, t("analysis.failed"));
        setError({ ...extracted, code: extracted.code ?? "ANALYSIS_START_FAILED" });
        settle(null);
      }
      return settled;
    },
    [queryClient, releaseLoader, settle, t],
  );

  const clear = useCallback(() => {
    setTaskId(null);
    setResult(null);
    setError(null);
    setCancelled(false);
    setElapsed(0);
    setLoading(false);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    settle(null);
    void queryClient.removeQueries({ queryKey: ["analysis"] });
  }, [queryClient, releaseLoader, settle]);

  const cancelAnalysis = useCallback(async () => {
    if (!taskId) return;
    try {
      await api.cancelAnalysis(taskId);
    } catch (cancelError) {
      const extracted = extractErrorMessage(cancelError, t("analysis.cancelFailed"));
      setError({ ...extracted, code: extracted.code ?? "ANALYSIS_CANCEL_FAILED" });
    }
  }, [taskId, t]);

  const progress = loading ? (status?.progress ?? null) : null;

  return {
    result,
    loading,
    error,
    cancelled,
    elapsed,
    progress,
    runAnalysis,
    cancelAnalysis,
    clear,
  };
}
