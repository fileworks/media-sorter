import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/context/toast-context";
import { extractErrorMessage } from "@/lib/errorUtils";
import type { OperationReport } from "@/types/api";

// Outer attempts at loading the report after a sort completes. Each attempt is
// itself a 3-try back-off (see fetchReportWithRetry), so this bounds the total
// recovery window while still surviving a transient post-completion hiccup.
const MAX_REPORT_ATTEMPTS = 3;

type SortingUIStatus = "idle" | "pending" | "running" | "completed" | "failed" | "cancelled";

// ── System notification ───────────────────────────────────────────────────────

/** Fetch the report; retry up to 3 times with 1s/2s/5s back-off so a brief
 *  DB-flush hiccup right after sort completion doesn't lose the report. */
async function fetchReportWithRetry(opId: string): Promise<OperationReport> {
  const delays = [1000, 2000, 5000];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await api.getReport(opId);
    } catch (err) {
      lastErr = err;
      if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  throw lastErr;
}

/** Request permission (if needed) and fire a system notification when the sort completes. */
async function notifyComplete(sorted: number, failed: number): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/api/notification");

    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    if (granted) {
      sendNotification({
        title: "MediaSorter — Sort Complete",
        body: `${sorted.toLocaleString()} files sorted${
          failed > 0 ? `, ${failed.toLocaleString()} failed` : ""
        }`,
        icon: "icons/icon.png",
      });
    }
  } catch {
    // Notification API not available (e.g., browser dev mode) — ignore
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSorting() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [uiStatus, setUiStatus] = useState<SortingUIStatus>("idle");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // We stop retrying the report once it loads, once there's nothing to load, or
  // once attempts are exhausted. This is state (not a ref) so flipping it
  // re-evaluates `isPolling` and lets the status poll wind down.
  const [reportSettled, setReportSettled] = useState(false);
  // The system "sort complete" notification must fire exactly once.
  const notifiedRef = useRef(false);
  // Tracks which percentage milestones (25, 50, 75) have already been toasted.
  const milestonesRef = useRef(new Set<number>());
  // Guards against overlapping report fetches while the status poll keeps ticking.
  const reportInFlightRef = useRef(false);
  const reportAttemptsRef = useRef(0);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);

  const releaseLoader = useCallback(() => {
    releaseLoaderRef.current?.();
    releaseLoaderRef.current = null;
  }, []);

  // Keep polling the (cheap, idempotent) status endpoint while the sort runs and
  // — crucially — after it completes until the report has been fetched (or we
  // give up). This is what lets a transient report-fetch failure recover: each
  // poll re-runs the completion effect, which retries the fetch.
  const isPolling =
    !!taskId &&
    (uiStatus === "pending" ||
      uiStatus === "running" ||
      (uiStatus === "completed" && report === null && !reportSettled));

  const { data: progress, error: progressError } = useQuery({
    queryKey: ["sorting", taskId],
    queryFn: () => (taskId ? api.getSortStatus(taskId, lastEventSequenceRef.current) : null),
    enabled: isPolling,
    refetchInterval: isPolling ? 1000 : false,
    retry: false,
  });

  // Sync backend status → UI status and fetch report when done
  useEffect(() => {
    if (!progress) return;
    lastEventSequenceRef.current = Math.max(
      lastEventSequenceRef.current,
      progress.last_event_sequence,
    );

    const s = progress.status;
    if (s === "running" || s === "completed" || s === "failed" || s === "cancelled") {
      setUiStatus(s);
    }

    // Milestone toasts at 25%, 50%, 75% (non-blocking, fire once each).
    // Gate on the "sorting" phase: the ranking pre-pass also walks 0→100% while
    // status is already "running", so without this the toasts would fire (and be
    // exhausted) during ranking, before any file is actually sorted. An absent
    // phase (older backend) falls through to no toast — the safe default.
    if (s === "running" && progress.progress?.phase === "sorting") {
      const { current, total, percentage } = progress.progress;
      if (total > 0 && percentage !== undefined) {
        const milestones = [
          {
            pct: 25,
            msg: `25% sorted — ${current.toLocaleString()} of ${total.toLocaleString()} files`,
          },
          {
            pct: 50,
            msg: `Halfway! ${current.toLocaleString()} of ${total.toLocaleString()} files sorted`,
          },
          {
            pct: 75,
            msg: `Almost done — ${current.toLocaleString()} of ${total.toLocaleString()} files sorted`,
          },
        ];
        for (const m of milestones) {
          if (percentage >= m.pct && !milestonesRef.current.has(m.pct)) {
            milestonesRef.current.add(m.pct);
            toast(m.msg, "info");
          }
        }
      }
    }

    if (s === "completed") {
      releaseLoader();
      // `result` is optional and loosely typed — read every field defensively
      // with runtime checks rather than an unsafe `as` cast.
      const result = progress.result;

      // Fire the system notification + counts exactly once for this sort.
      if (!notifiedRef.current) {
        notifiedRef.current = true;
        const sorted = typeof result?.sorted === "number" ? result.sorted : 0;
        const failed = typeof result?.failed === "number" ? result.failed : 0;
        void notifyComplete(sorted, failed);
      }

      const opId = typeof result?.operation_id === "string" ? result.operation_id : null;
      if (!opId) {
        // No operation record to fetch — surface once and stop polling.
        if (!reportSettled) {
          setReportSettled(true);
          toast("Sort completed, but no report record was found.", "warning");
        }
        return;
      }
      setOperationId(opId);

      // Fetch the report. The "fetched" flag flips only on success, so a
      // transient failure lets the next status poll retry. An in-flight
      // ref prevents overlapping fetches; attempts are bounded so a permanent
      // failure eventually stops polling instead of looping forever.
      if (report === null && !reportSettled && !reportInFlightRef.current) {
        reportInFlightRef.current = true;
        reportAttemptsRef.current += 1;
        const attempt = reportAttemptsRef.current;
        void fetchReportWithRetry(opId)
          .then((data) => {
            setReport(data);
            setReportSettled(true);
            toast("Sorting complete! Report is ready.", "success");
          })
          .catch(() => {
            if (attempt >= MAX_REPORT_ATTEMPTS) {
              setReportSettled(true);
              toast("Sort completed but report could not be loaded.", "warning");
            }
          })
          .finally(() => {
            reportInFlightRef.current = false;
          });
      }
    }

    if (s === "failed") {
      releaseLoader();
      toast(
        progress.failure?.message ?? progress.error ?? "Sort failed. Check logs for details.",
        "error",
      );
    } else if (s === "cancelled") {
      releaseLoader();
    }
  }, [progress, toast, report, reportSettled, releaseLoader]);

  useEffect(() => {
    if (!progressError || uiStatus === "failed") return;
    const message = extractErrorMessage(progressError, "Sort status could not be read");
    setUiStatus("failed");
    setError(message);
    releaseLoader();
    toast(message, "error");
  }, [progressError, uiStatus, releaseLoader, toast]);

  useEffect(() => releaseLoader, [releaseLoader]);

  const startSorting = useCallback(
    async (dryRun = false) => {
      // Clear old task id before the async call so the stale ["sorting", oldId]
      // query is never polled during the API round-trip.
      setTaskId(null);
      void queryClient.removeQueries({ queryKey: ["sorting"] });
      setError(null);
      setReport(null);
      setOperationId(null);
      setReportSettled(false);
      notifiedRef.current = false;
      milestonesRef.current = new Set();
      reportInFlightRef.current = false;
      reportAttemptsRef.current = 0;
      lastEventSequenceRef.current = 0;
      releaseLoader();
      releaseLoaderRef.current = api.beginOperation();
      setUiStatus("pending");
      try {
        const id = await api.startSort(dryRun);
        setTaskId(id);
        setUiStatus("running");
      } catch (err) {
        releaseLoader();
        const msg = extractErrorMessage(err, "Failed to start sort");
        setUiStatus("failed");
        setError(msg);
        toast(msg, "error");
      }
    },
    [toast, queryClient, releaseLoader],
  );

  const cancelSorting = useCallback(async () => {
    if (!taskId) return;
    // If the backend has already transitioned to a terminal state, don't fire
    // the cancel POST — that would race with the completion toast.
    const currentStatus = progress?.status;
    if (
      currentStatus === "completed" ||
      currentStatus === "failed" ||
      currentStatus === "cancelled"
    ) {
      return;
    }
    try {
      await api.cancelSort(taskId);
      toast("Cancellation requested.", "info");
    } catch (err) {
      const msg = extractErrorMessage(err, "Failed to cancel");
      setError(msg);
      toast(msg, "error");
    }
  }, [taskId, toast, progress]);

  // Invalidate report-history cache whenever a sort completes so HistoryPanel
  // automatically shows the new operation without a manual refresh.
  useEffect(() => {
    if (uiStatus === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    }
  }, [uiStatus, queryClient]);

  const clearReport = useCallback(() => {
    setReport(null);
    setTaskId(null);
    setOperationId(null);
    setUiStatus("idle");
    setError(null);
    setReportSettled(false);
    notifiedRef.current = false;
    milestonesRef.current = new Set();
    reportInFlightRef.current = false;
    reportAttemptsRef.current = 0;
    lastEventSequenceRef.current = 0;
    releaseLoader();
    void queryClient.removeQueries({ queryKey: ["sorting"] });
  }, [queryClient, releaseLoader]);

  return {
    progress,
    report,
    operationId,
    status: uiStatus,
    error,
    startSorting,
    cancelSorting,
    clearReport,
  };
}
