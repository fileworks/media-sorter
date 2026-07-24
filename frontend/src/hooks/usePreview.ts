import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
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
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Guard so we handle the terminal status exactly once.
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);

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
      releaseLoader();
      if (status.result) setResult(status.result);
      else setError(t("preview.noResult"));
    } else if (status.status === "failed") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
      setError(status.failure?.message ?? status.error ?? t("preview.failed"));
    } else if (status.status === "cancelled") {
      handledRef.current = true;
      setLoading(false);
      releaseLoader();
    }
  }, [status, releaseLoader, t]);

  useEffect(() => {
    if (!statusError || handledRef.current) return;
    handledRef.current = true;
    setLoading(false);
    releaseLoader();
    setError(extractErrorMessage(statusError, t("preview.statusFailed")));
  }, [statusError, releaseLoader, t]);

  useEffect(() => releaseLoader, [releaseLoader]);

  const generatePreview = useCallback(async () => {
    // Clear the old task id *before* setting loading so the stale query key
    // (`["preview", oldId]`) is never polled during the async startPreview call.
    setTaskId(null);
    void queryClient.removeQueries({ queryKey: ["preview"] });
    setError(null);
    setResult(null);
    setElapsed(0);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    releaseLoaderRef.current = api.beginOperation();
    setLoading(true);
    try {
      const id = await api.startPreview();
      setTaskId(id);
    } catch (err) {
      releaseLoader();
      setError(extractErrorMessage(err, t("preview.failed")));
      setLoading(false);
    }
  }, [queryClient, releaseLoader, t]);

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
    setElapsed(0);
    setTaskId(null);
    setLoading(false);
    handledRef.current = false;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    void queryClient.removeQueries({ queryKey: ["preview"] });
  }, [queryClient, releaseLoader]);

  const cancelPreview = useCallback(async () => {
    if (taskId) {
      try {
        await api.cancelPreview(taskId);
        // Keep polling until the worker observes the request and reports the
        // terminal cancelled state; that is also when the global loader ends.
        return;
      } catch (cancelError) {
        setError(extractErrorMessage(cancelError, t("preview.cancelFailed")));
      }
    }
  }, [taskId, t]);

  // Live progress only while the run is in flight.
  const progress: TaskProgress | null = loading ? (status?.progress ?? null) : null;

  return { loading, error, result, elapsed, progress, generatePreview, cancelPreview, clear };
}
