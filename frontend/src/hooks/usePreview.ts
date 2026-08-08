import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage, userFacingError, type ExtractedError } from "@/lib/errorUtils";
import type { PreviewResult, TaskProgress } from "@/types/api";

/**
 * Runs the preview as a background task and polls for real progress, so the UI
 * can show a determinate "N / M files" bar instead of an opaque spinner.
 */
export function usePreview() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ExtractedError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Guard so we handle the terminal status exactly once.
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);
  // Same contract as `useAnalysis.runAnalysis`: starting the task and finishing
  // it are different moments, and a caller chaining work after the dry run has
  // to await the second one.
  const settleRef = useRef<((result: PreviewResult | null) => void) | null>(null);

  const settle = useCallback((value: PreviewResult | null) => {
    settleRef.current?.(value);
    settleRef.current = null;
  }, []);

  const releaseLoader = useCallback(() => {
    releaseLoaderRef.current?.();
    releaseLoaderRef.current = null;
  }, []);

  const isPolling = !!taskId && loading;

  const { data: status, error: statusError } = useQuery({
    queryKey: ["preview", taskId],
    queryFn: () => (taskId ? api.getPreviewStatus(taskId, lastEventSequenceRef.current) : null),
    enabled: isPolling,
    refetchInterval: isPolling ? 500 : false,
    retry: false,
  });

  // Count up elapsed seconds while loading (fallback label before total is known)
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [loading]);

  // React to terminal statuses
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
      else setError({ message: t("preview.noResult"), code: "PREVIEW_NO_RESULT" });
      settle(status.result ?? null);
    } else if (status.status === "failed") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      setError({
        message: userFacingError(status.failure?.message ?? status.error ?? t("preview.failed")),
        code: status.failure?.code ?? "PREVIEW_FAILED",
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
    const extracted = extractErrorMessage(statusError, t("preview.statusFailed"));
    setError({ ...extracted, code: extracted.code ?? "PREVIEW_STATUS_UNAVAILABLE" });
    settle(null);
  }, [statusError, releaseLoader, settle, t]);

  useEffect(
    () => () => {
      releaseLoader();
      settle(null);
    },
    [releaseLoader, settle],
  );

  const generatePreview = useCallback(
    async (excludedRoots: string[] = []): Promise<PreviewResult | null> => {
      settle(null);
      // Clear the old task id *before* setting loading so the stale query key
      // (`["preview", oldId]`) is never polled during the async startPreview call.
      setTaskId(null);
      void queryClient.removeQueries({ queryKey: ["preview"] });
      setError(null);
      setCancelled(false);
      setResult(null);
      setElapsed(0);
      handledRef.current = false;
      lastEventSequenceRef.current = 0;
      releaseLoader();
      releaseLoaderRef.current = api.beginOperation();
      setLoading(true);
      const settled = new Promise<PreviewResult | null>((resolve) => {
        settleRef.current = resolve;
      });
      try {
        const id = await api.startPreview(excludedRoots);
        setTaskId(id);
      } catch (err) {
        handledRef.current = true;
        releaseLoader();
        const extracted = extractErrorMessage(err, t("preview.failed"));
        setError({ ...extracted, code: extracted.code ?? "PREVIEW_START_FAILED" });
        setLoading(false);
        settle(null);
      }
      return settled;
    },
    [queryClient, releaseLoader, settle, t],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
    setCancelled(false);
    setElapsed(0);
    setTaskId(null);
    setLoading(false);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    settle(null);
    void queryClient.removeQueries({ queryKey: ["preview"] });
  }, [queryClient, releaseLoader, settle]);

  const cancelPreview = useCallback(async () => {
    if (taskId) {
      try {
        await api.cancelPreview(taskId);
        // Keep polling until the worker observes the request and reports the
        // terminal cancelled state; that is also when the global loader ends.
        return;
      } catch (cancelError) {
        const extracted = extractErrorMessage(cancelError, t("preview.cancelFailed"));
        setError({ ...extracted, code: extracted.code ?? "PREVIEW_CANCEL_FAILED" });
      }
    }
  }, [taskId, t]);

  // Live progress only while the run is in flight.
  const progress: TaskProgress | null = loading ? (status?.progress ?? null) : null;

  return {
    loading,
    error,
    cancelled,
    result,
    elapsed,
    progress,
    generatePreview,
    cancelPreview,
    clear,
  };
}
