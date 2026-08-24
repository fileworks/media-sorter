import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage, userFacingError, type ExtractedError } from "@/lib/errorUtils";
import { dropScopedExcept, readStored, removeStored, writeStored } from "@/lib/storage";
import type { PlanRecoveryResponse } from "@/services/api";
import type { AnalysisResult, PreviewResult, TaskProgress } from "@/types/api";

const COMPLETED_PLAN_KEY = "mediasort_completed_plan";
/** Review's own per-plan snapshots, dropped with the plan they belong to. */
const PLAN_SCOPED_PREFIXES = ["mediasort_review_state:", "mediasort_review_stop:"];

/** Forget the completed plan and everything the Review screen kept about it. */
function forgetCompletedPlan(): void {
  removeStored(COMPLETED_PLAN_KEY);
  for (const prefix of PLAN_SCOPED_PREFIXES) dropScopedExcept(prefix, null);
}

interface StoredCompletedPlan {
  schemaVersion: 2;
  planId: string;
  result: PreviewResult;
  recovery: PlanRecoveryResponse;
  /**
   * The scan the plan was built from.
   *
   * Kept here rather than under a key of its own so it inherits the plan's
   * proof: it is restored only when the backend still vouches for the same
   * plan, configuration, destination and sources. Without it a restart brought
   * the plan back and left the scan behind, so the stepper showed every stage
   * complete while Configure said the folders had never been scanned.
   */
  analysis: AnalysisResult | null;
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function sameReviewedSets(
  left: PlanRecoveryResponse["reviewed_sets"],
  right: PlanRecoveryResponse["reviewed_sets"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecovery(left: PlanRecoveryResponse, right: PlanRecoveryResponse): boolean {
  return (
    left.plan_id === right.plan_id &&
    left.config_fingerprint === right.config_fingerprint &&
    left.destination_fingerprint === right.destination_fingerprint &&
    sameStringMap(left.source_fingerprints, right.source_fingerprints) &&
    sameReviewedSets(left.reviewed_sets, right.reviewed_sets)
  );
}

function validStoredPlan(value: unknown): value is StoredCompletedPlan {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Partial<StoredCompletedPlan>;
  if (
    stored.schemaVersion !== 2 ||
    typeof stored.planId !== "string" ||
    stored.planId.length === 0 ||
    typeof stored.result !== "object" ||
    stored.result === null ||
    typeof stored.recovery !== "object" ||
    stored.recovery === null ||
    (stored.analysis !== null && typeof stored.analysis !== "object")
  ) {
    return false;
  }
  const result = stored.result as Partial<PreviewResult>;
  const recovery = stored.recovery as Partial<PlanRecoveryResponse>;
  return (
    result.plan_id === stored.planId &&
    recovery.plan_id === stored.planId &&
    typeof result.config_fingerprint === "string" &&
    result.config_fingerprint === recovery.config_fingerprint &&
    typeof recovery.destination_fingerprint === "string" &&
    recovery.destination_fingerprint.length > 0 &&
    typeof recovery.source_fingerprints === "object" &&
    recovery.source_fingerprints !== null &&
    Array.isArray(recovery.reviewed_sets)
  );
}

/**
 * Runs the preview as a background task and polls for real progress, so the UI
 * can show a determinate "N / M files" bar instead of an opaque spinner.
 */
export function usePreview(scan: AnalysisResult | null = null) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ExtractedError | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [generation, setGeneration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [rehydrated, setRehydrated] = useState(false);
  /** True only after the backend revalidates a durable completed-plan snapshot. */
  const [recovered, setRecovered] = useState(false);
  /** The scan that came back with a recovered plan, until a live one replaces it. */
  const [recoveredScan, setRecoveredScan] = useState<AnalysisResult | null>(null);
  const [recoveryEvidence, setRecoveryEvidence] = useState<PlanRecoveryResponse | null>(null);
  // Guard so we handle the terminal status exactly once.
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);
  // Same contract as `useAnalysis.runAnalysis`: starting the task and finishing
  // it are different moments, and a caller chaining work after the dry run has
  // to await the second one.
  const settleRef = useRef<((result: PreviewResult | null) => void) | null>(null);

  // The backend owns the frozen plan; this local snapshot owns the review
  // rendering data. Rehydrate only after the backend proves the plan,
  // configuration, destination and source fingerprints are still current.
  useEffect(() => {
    let mounted = true;
    const raw = readStored(COMPLETED_PLAN_KEY);
    if (raw === null) {
      setRehydrated(true);
      return () => {
        mounted = false;
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      forgetCompletedPlan();
      setRehydrated(true);
      return () => {
        mounted = false;
      };
    }
    if (!validStoredPlan(parsed)) {
      forgetCompletedPlan();
      setRehydrated(true);
      return () => {
        mounted = false;
      };
    }
    const storedPlan = parsed;
    void api
      .recoverSortPlan(storedPlan.planId)
      .then((liveRecovery) => {
        if (!mounted) return;
        if (!sameRecovery(storedPlan.recovery, liveRecovery)) {
          forgetCompletedPlan();
          return;
        }
        setRecoveryEvidence(liveRecovery);
        setRecovered(true);
        setRecoveredScan(storedPlan.analysis);
        setResult(storedPlan.result);
        setGeneration((current) => current + 1);
      })
      .catch(() => {
        if (mounted) forgetCompletedPlan();
      })
      .finally(() => {
        if (mounted) setRehydrated(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!rehydrated) return;
    if (result === null) {
      forgetCompletedPlan();
      return;
    }
    let cancelled = false;
    const persist = (evidence: PlanRecoveryResponse) => {
      if (cancelled) return;
      const stored: StoredCompletedPlan = {
        schemaVersion: 2,
        planId: result.plan_id,
        result,
        recovery: evidence,
        analysis: scan ?? recoveredScan,
      };
      writeStored(COMPLETED_PLAN_KEY, JSON.stringify(stored));
    };
    if (
      recoveryEvidence?.plan_id === result.plan_id &&
      recoveryEvidence.config_fingerprint === result.config_fingerprint
    ) {
      persist(recoveryEvidence);
    } else {
      void api
        .recoverSortPlan(result.plan_id)
        .then((evidence) => {
          if (
            evidence.plan_id !== result.plan_id ||
            evidence.config_fingerprint !== result.config_fingerprint
          ) {
            forgetCompletedPlan();
            return;
          }
          setRecoveryEvidence(evidence);
          persist(evidence);
        })
        .catch(() => {
          if (!cancelled) forgetCompletedPlan();
        });
    }
    return () => {
      cancelled = true;
    };
  }, [recoveredScan, recoveryEvidence, rehydrated, result, scan]);

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
      if (status.result) {
        setRecovered(false);
        setResult(status.result);
        setGeneration((current) => current + 1);
      } else setError({ message: t("preview.noResult"), code: "PREVIEW_NO_RESULT" });
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
      setRecovered(false);
      setRecoveredScan(null);
      setRecoveryEvidence(null);
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
    setRecovered(false);
    setRecoveredScan(null);
    setRecoveryEvidence(null);
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
    forgetCompletedPlan();
  }, [queryClient, releaseLoader, settle]);

  const resumePreview = useCallback(
    (activeTaskId: string) => {
      if (taskId === activeTaskId && loading) return;
      settle(null);
      setResult(null);
      setRecovered(false);
      setRecoveredScan(null);
      setRecoveryEvidence(null);
      setError(null);
      setCancelled(false);
      setElapsed(0);
      handledRef.current = false;
      lastEventSequenceRef.current = 0;
      releaseLoader();
      releaseLoaderRef.current = api.beginOperation();
      setTaskId(activeTaskId);
      setLoading(true);
    },
    [loading, releaseLoader, settle, taskId],
  );

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
    taskId,
    generation,
    loading,
    error,
    cancelled,
    result,
    elapsed,
    progress,
    rehydrated,
    recovered,
    recoveredScan,
    generatePreview,
    resumePreview,
    cancelPreview,
    clear,
  };
}
