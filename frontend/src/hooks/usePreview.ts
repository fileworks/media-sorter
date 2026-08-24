import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage, userFacingError, type ExtractedError } from "@/lib/errorUtils";
import { dropScopedExcept, readStored, removeStored, writeStored } from "@/lib/storage";
import type { PlanRecoveryResponse } from "@/services/api";
import type { AnalysisResult, PreviewResult, TaskProgress } from "@/types/api";

const COMPLETED_PLAN_KEY = "mediasort_completed_plan";
/** Legacy browser snapshots plus the current per-plan view stop. */
const PLAN_SCOPED_PREFIXES = ["mediasort_review_state:", "mediasort_review_stop:"];

/** Forget the completed plan and everything the Review screen kept about it. */
function forgetCompletedPlan(): void {
  removeStored(COMPLETED_PLAN_KEY);
  for (const prefix of PLAN_SCOPED_PREFIXES) dropScopedExcept(prefix, null);
}

interface StoredCompletedPlan {
  schemaVersion: 3;
  planId: string;
  configFingerprint: string;
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

function validStoredPlan(value: unknown): value is StoredCompletedPlan {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Partial<StoredCompletedPlan>;
  if (
    stored.schemaVersion !== 3 ||
    typeof stored.planId !== "string" ||
    stored.planId.length === 0 ||
    typeof stored.configFingerprint !== "string" ||
    stored.configFingerprint.length === 0 ||
    (stored.analysis !== null && typeof stored.analysis !== "object")
  ) {
    return false;
  }
  return true;
}

export type PlanPersistenceState = "idle" | "saving" | "saved" | "error";

/**
 * Runs the preview as a background task and polls for real progress, so the UI
 * can show a determinate "N / M files" bar instead of an opaque spinner.
 */
export function usePreview(scan: AnalysisResult | null = null) {
  const { t } = useI18n();
  const recoveryTranslateRef = useRef(t);
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
  const [persistenceState, setPersistenceState] = useState<PlanPersistenceState>("idle");
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [persistenceAttempt, setPersistenceAttempt] = useState(0);
  // Guard so we handle the terminal status exactly once.
  const handledRef = useRef(false);
  const releaseLoaderRef = useRef<(() => void) | null>(null);
  const lastEventSequenceRef = useRef(0);
  // Same contract as `useAnalysis.runAnalysis`: starting the task and finishing
  // it are different moments, and a caller chaining work after the dry run has
  // to await the second one.
  const settleRef = useRef<((result: PreviewResult | null) => void) | null>(null);

  // localStorage owns only a compact pointer. The backend owns the frozen plan,
  // the exact rendered snapshot, all fingerprints, and Review's durable state.
  // A large library therefore cannot silently overflow browser storage and
  // leave the UI pretending that restart recovery is available.
  useEffect(() => {
    const translate = recoveryTranslateRef.current;
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
    setPersistenceState("saving");
    setPersistenceError(null);
    void api
      .recoverSortPlan(storedPlan.planId)
      .then((liveRecovery) => {
        if (!mounted) return;
        const liveResult = liveRecovery.preview_result;
        if (
          liveRecovery.plan_id !== storedPlan.planId ||
          liveRecovery.config_fingerprint !== storedPlan.configFingerprint ||
          liveResult.plan_id !== storedPlan.planId ||
          liveResult.config_fingerprint !== storedPlan.configFingerprint
        ) {
          forgetCompletedPlan();
          setPersistenceState("error");
          setPersistenceError(translate("review.persistence.stale"));
          return;
        }
        setRecoveryEvidence(liveRecovery);
        setRecovered(true);
        setRecoveredScan(storedPlan.analysis);
        setResult(liveResult);
        setPersistenceState("saved");
        setGeneration((current) => current + 1);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        forgetCompletedPlan();
        setPersistenceState("error");
        setPersistenceError(
          extractErrorMessage(cause, translate("review.persistence.recoveryFailed")).message,
        );
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
      // Rehydration also reaches this branch after a failed/stale recovery.
      // Keep that actionable error visible; explicit clear/new-run paths reset
      // persistence themselves.
      setPersistenceState((current) => (current === "error" ? current : "idle"));
      return;
    }
    const persist = () => {
      const stored: StoredCompletedPlan = {
        schemaVersion: 3,
        planId: result.plan_id,
        configFingerprint: result.config_fingerprint,
        analysis: scan ?? recoveredScan,
      };
      if (!writeStored(COMPLETED_PLAN_KEY, JSON.stringify(stored))) {
        setPersistenceState("error");
        setPersistenceError(t("review.persistence.pointerFailed"));
        return;
      }
      setPersistenceState("saved");
      setPersistenceError(null);
    };
    setPersistenceState("saving");
    setPersistenceError(null);
    // A completed preview is returned only after PreviewService has durably
    // written the frozen plan and this exact snapshot. Calling recovery here
    // used to hash the complete destination a second time before Review could
    // proceed. Full freshness validation belongs at restart recovery and live
    // execution; the new-plan path only needs to store its compact pointer.
    if (recoveryEvidence === null) {
      persist();
      return;
    }
    if (
      recoveryEvidence.plan_id !== result.plan_id ||
      recoveryEvidence.config_fingerprint !== result.config_fingerprint ||
      recoveryEvidence.preview_result.plan_id !== result.plan_id ||
      recoveryEvidence.preview_result.config_fingerprint !== result.config_fingerprint
    ) {
      setPersistenceState("error");
      setPersistenceError(t("review.persistence.stale"));
      return;
    }
    persist();
  }, [persistenceAttempt, recoveredScan, recoveryEvidence, rehydrated, result, scan, t]);

  const retryPersistence = useCallback(() => {
    setPersistenceAttempt((current) => current + 1);
  }, []);

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
      setPersistenceState("idle");
      setPersistenceError(null);
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
    setPersistenceState("idle");
    setPersistenceError(null);
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
    recoveryEvidence,
    persistenceState,
    persistenceError,
    retryPersistence,
    generatePreview,
    resumePreview,
    cancelPreview,
    clear,
  };
}
