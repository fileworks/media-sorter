import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { PreviewResult, TaskProgress } from "@/types/api";

/**
 * Runs the preview as a background task and polls for real progress, so the UI
 * can show a determinate "N / M files" bar instead of an opaque spinner.
 */
export function usePreview() {
  const queryClient = useQueryClient();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Guard so we handle the terminal status exactly once.
  const handledRef = useRef(false);

  const isPolling = !!taskId && loading;

  const { data: status } = useQuery({
    queryKey: ["preview", taskId],
    queryFn: () => (taskId ? api.getPreviewStatus(taskId) : null),
    enabled: isPolling,
    refetchInterval: isPolling ? 500 : false,
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

    if (status.status === "completed") {
      handledRef.current = true;
      setLoading(false);
      if (status.result) setResult(status.result);
      else setError("Preview produced no result.");
    } else if (status.status === "failed") {
      handledRef.current = true;
      setLoading(false);
      setError(status.error ?? "Preview failed.");
    } else if (status.status === "cancelled") {
      handledRef.current = true;
      setLoading(false);
    }
  }, [status]);

  const generatePreview = useCallback(async () => {
    // Clear the old task id *before* setting loading so the stale query key
    // (`["preview", oldId]`) is never polled during the async startPreview call.
    setTaskId(null);
    void queryClient.removeQueries({ queryKey: ["preview"] });
    setError(null);
    setResult(null);
    setElapsed(0);
    handledRef.current = false;
    setLoading(true);
    try {
      const id = await api.startPreview();
      setTaskId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
      setLoading(false);
    }
  }, [queryClient]);

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
    setElapsed(0);
    setTaskId(null);
    setLoading(false);
    handledRef.current = false;
    void queryClient.removeQueries({ queryKey: ["preview"] });
  }, [queryClient]);

  const cancelPreview = useCallback(async () => {
    if (taskId) {
      try {
        await api.cancelPreview(taskId);
      } catch {
        // ignore — clear local state regardless
      }
    }
    clear();
  }, [taskId, clear]);

  // Live progress only while the run is in flight.
  const progress: TaskProgress | null = loading ? (status?.progress ?? null) : null;

  return { loading, error, result, elapsed, progress, generatePreview, cancelPreview, clear };
}
