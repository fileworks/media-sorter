import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useConfig } from "@/hooks/useConfig";
import type { Config, OperationReport } from "@/types/api";
import { useGlobalLoader } from "@/hooks/useGlobalLoader";
import { useAnalysis } from "@/hooks/useAnalysis";
import { useSorting } from "@/hooks/useSorting";
import { usePreview } from "@/hooks/usePreview";
import { useToast } from "@/context/toast-context";
import { useTheme } from "@/hooks/useTheme";
import { StepIndicator, type WizardStep } from "@/components/StepIndicator";
import { ConfigPanel } from "@/components/ConfigPanel";
import { AnalysisPanel } from "@/components/AnalysisPanel";
import { PreviewPanel } from "@/components/PreviewPanel";
import { SortingProgress } from "@/components/SortingProgress";
import { PreviewProgressCard } from "@/components/PreviewProgressCard";
import { ReportPanel } from "@/components/ReportPanel";
import { LogViewer } from "@/components/LogViewer";
import { Button } from "@/components/ui/button";
import { cn, isTauri } from "@/lib/utils";
import { formatDuration } from "@/lib/formatters";
import {
  FiSun,
  FiMoon,
  FiClock,
  FiArrowLeft,
  FiArrowRight,
  FiAlertTriangle,
  FiLoader,
  FiXCircle,
  FiCheckCircle,
  FiX,
} from "react-icons/fi";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// History is a separate page reached only by the header button — defer its
// bundle (panel + report modal path) until the user actually opens it.
const HistoryPanel = lazy(() =>
  import("@/components/HistoryPanel").then((m) => ({ default: m.HistoryPanel })),
);

// ── First-run welcome card ─────────────────────────────────────────────────────

const WELCOME_KEY = "mediasort_welcome_seen";

function FirstRunWelcome({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="animate-fade-in rounded-xl border border-primary/20 bg-primary/10 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <FiCheckCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Welcome to MediaSorter</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Point it at your messy media folder, choose where to put the sorted copies, and click{" "}
            <strong>Analyze</strong>. Your originals are never moved or deleted.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground/60 hover:text-muted-foreground"
          aria-label="Dismiss welcome message"
        >
          <FiX className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Sort-complete celebration banner ──────────────────────────────────────────

function SortCelebration({ report }: { report: OperationReport }) {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const { summary, duration_seconds } = report;
  const quarantineCount =
    summary.future_dates + summary.unknown_dates + summary.corrupted + (summary.junk ?? 0);
  const duplicateCount = summary.duplicates + (summary.already_in_destination ?? 0);

  return (
    <div className="animate-fade-in rounded-xl border border-primary/30 bg-primary/10 px-5 py-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
          <FiCheckCircle className="animate-celebration-bloom h-6 w-6 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">
            {summary.sorted.toLocaleString()} files organized
            {duration_seconds ? ` in ${formatDuration(duration_seconds, { style: "long" })}` : ""}
          </p>
          {(quarantineCount > 0 || duplicateCount > 0) && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {duplicateCount > 0 && `${duplicateCount.toLocaleString()} duplicates quarantined`}
              {duplicateCount > 0 && quarantineCount > 0 && " · "}
              {quarantineCount > 0 &&
                `${quarantineCount.toLocaleString()} files in special folders`}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="shrink-0 rounded p-1 text-primary/50 hover:text-primary"
          aria-label="Dismiss"
        >
          <FiX className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * The app-wide "something is computing" indicator: a thin orange bar pinned to
 * the very top of the window that flows left-to-right whenever any non-trivial
 * work is in flight (config load/save, analysis, preview, sort, history, …).
 * Its host header must be `position: relative`.
 */
function TopProgressBar({ busy }: { busy: boolean }) {
  if (!busy) return null;
  return <div className="progress-indeterminate absolute inset-x-0 top-0 h-0.5" aria-hidden />;
}

export default function MainPage() {
  const { toast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const { config, isValid, updateConfig } = useConfig();

  // ── Hooks ──────────────────────────────────────────────────────────────────

  const {
    result: analysisResult,
    loading: analysisLoading,
    error: analysisError,
    runAnalysis,
    clear: clearAnalysis,
  } = useAnalysis();

  const {
    result: previewResult,
    loading: previewLoading,
    error: previewError,
    elapsed: previewElapsed,
    progress: previewProgress,
    generatePreview,
    cancelPreview,
    clear: clearPreview,
  } = usePreview();

  const {
    progress,
    status,
    error: sortError,
    report,
    startSorting,
    cancelSorting,
    clearReport,
  } = useSorting();

  // ── View state ─────────────────────────────────────────────────────────────
  // "wizard" is the normal 5-step flow; "history" is a separate full page

  const [view, setView] = useState<"wizard" | "history">("wizard");
  const [step, setStep] = useState<WizardStep>(1);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  // Pending config patch: held here until the user confirms the settings change dialog
  const [pendingConfigPatch, setPendingConfigPatch] = useState<Partial<Config> | null>(null);
  // Incremented when user cancels a pending config change to force-remount ConfigPanel inputs
  const [sectionBodyKey, setSectionBodyKey] = useState(0);
  // Re-run confirmation: when user clicks "Run Preview" / "Sort Now" over existing results
  const [rerunConfirmType, setRerunConfirmType] = useState<"preview" | "sort" | null>(null);

  // ── First-run welcome ──────────────────────────────────────────────────────

  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_KEY);
    } catch {
      return false;
    }
  });

  const dismissWelcome = useCallback(() => {
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      // ignore
    }
    setWelcomeVisible(false);
  }, []);

  // ── Update check ───────────────────────────────────────────────────────────

  const { data: updateInfo } = useUpdateCheck();

  // ── Backend health ─────────────────────────────────────────────────────────

  const {
    data: health,
    isLoading: healthLoading,
    isError: healthError,
    failureCount: healthFailureCount,
  } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 10_000,
    retry: 3,
  });

  // Derive backend reachability from error state (not just data presence), so
  // the warning correctly reappears after the backend goes down once it was up.
  const backendDown = healthError || (healthFailureCount >= 3 && !health);

  const [showBackendWarning, setShowBackendWarning] = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (health?.status === "ok" && !backendDown) {
      setShowBackendWarning(false);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      return;
    }
    if (backendDown) {
      warningTimerRef.current = setTimeout(() => setShowBackendWarning(true), 4000);
    }
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, [health, backendDown]);

  // ── History count (badge in header) ────────────────────────────────────────

  const { data: historyMeta } = useQuery({
    queryKey: ["reports", 1, 0],
    queryFn: () => api.listReports(1, 0),
    staleTime: 30_000,
    enabled: health?.status === "ok",
  });
  const historyCount = historyMeta?.total ?? 0;

  // ── Config validation ───────────────────────────────────────────────────────
  // `isValid` (from useConfig's single validation query) already covers every
  // problem — missing/not-found source, missing destination, out-of-range
  // settings. Each problem is surfaced in-place: the offending section is
  // flagged in the settings rail and the field itself shows the message.

  // Gating only — the *message* for "no media" lives in AnalysisPanel (the one
  // place that actually has the scan result), not as a flaky step-1 guess.
  const sourceHasNoMedia =
    analysisResult !== null && !analysisLoading && analysisResult.total_files === 0;

  // ── Wizard step gating ─────────────────────────────────────────────────────

  const canGoToAnalysis = isValid;
  const canGoToPreview =
    analysisResult !== null &&
    !analysisError &&
    analysisResult.disk_space.sufficient === true &&
    !sourceHasNoMedia;
  const canGoToSort = previewResult !== null;
  const isRunning = status === "running" || status === "pending";
  const isAnyRunning = analysisLoading || previewLoading || isRunning;

  // Which steps have valid results — drives stepper completion markers.
  // Step 1 is marked done when we've moved past it (analysis exists).
  const doneSteps = useMemo((): ReadonlySet<WizardStep> => {
    const s = new Set<WizardStep>();
    if (step > 1 || (analysisResult && !analysisError)) s.add(1);
    if (analysisResult && !analysisError) s.add(2);
    if (previewResult && !previewError) s.add(3);
    if (status === "completed") s.add(4);
    if (report) s.add(5);
    return s;
  }, [step, analysisResult, analysisError, previewResult, previewError, status, report]);

  // Highest step the user may navigate to — derived from actual data, not a separate state.
  // In-progress operations keep their step navigable even if results aren't available yet.
  const navigableUpTo = useMemo((): WizardStep => {
    let max: number = step;
    if (analysisResult && !analysisError) max = Math.max(max, 2);
    if (analysisLoading) max = Math.max(max, 2);
    if (previewResult && !previewError) max = Math.max(max, 3);
    if (previewLoading) max = Math.max(max, 3);
    if (isRunning || status === "completed") max = Math.max(max, 4);
    if (report) max = Math.max(max, 5);
    return max as WizardStep;
  }, [
    step,
    analysisResult,
    analysisError,
    analysisLoading,
    previewResult,
    previewError,
    previewLoading,
    isRunning,
    status,
    report,
  ]);

  // App-wide busy signal for the top bar: only genuinely long operations drive
  // it. `isAnyRunning` covers analysis/preview/sort continuously across their
  // poll cadence; `loaderActive` covers any other heavy one-shot request tagged
  // via `withLoader`. Config saves, toggles, validation, and GETs are excluded
  // by construction, so the bar no longer blinks on every setting change.
  const loaderActive = useGlobalLoader();
  const globalBusy = isAnyRunning || loaderActive;

  // ── Navigation ─────────────────────────────────────────────────────────────

  // Configure needs the two-pane layout; Preview expands to fill available space;
  // other steps stay narrow for legibility.
  const contentWidth = step === 1 ? "max-w-5xl" : step === 3 ? "max-w-6xl" : "max-w-3xl";

  // Navigation is always free — computing status is shown in the footer instead of blocking navigation.
  const goToStep = (s: WizardStep) => setStep(s);

  // Auto-advance to Report when sort completes
  useEffect(() => {
    if (status === "completed" && report && step !== 5) {
      goToStep(5);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, report]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleAnalyse = async () => {
    if (!canGoToAnalysis) {
      toast("Set a valid source and destination folder first.", "warning");
      return;
    }
    goToStep(2);
    await runAnalysis();
  };

  const handlePreview = async () => {
    if (!canGoToPreview) {
      if (!analysisResult) {
        toast("Run Analysis first.", "warning");
      } else if (!analysisResult.disk_space.sufficient) {
        toast("Not enough disk space. Free up space or switch to Move mode.", "warning");
      }
      return;
    }
    goToStep(3);
    await generatePreview();
  };

  const handleSort = async () => {
    if (!canGoToSort) {
      toast("Run Preview first.", "warning");
      return;
    }
    goToStep(4);
    await startSorting(false);
  };

  // Determine which computation is cancellable (only one active at a time)
  const cancellableOp = previewLoading ? "preview" : isRunning ? "sort" : null;

  const handleCancelRequest = () => {
    if (!cancellableOp) return;
    setCancelConfirmOpen(true);
  };

  const handleCancelConfirmed = async () => {
    setCancelConfirmOpen(false);
    if (cancellableOp === "preview") {
      await cancelPreview();
    } else if (cancellableOp === "sort") {
      void cancelSorting();
    }
  };

  const handleNewSort = () => {
    clearAnalysis();
    clearPreview();
    clearReport();
    setStep(1);
  };

  // ── Config-change interceptor ──────────────────────────────────────────────
  // Saves go through here; if there are existing results the change is held
  // until the user confirms. On dismiss, sectionBodyKey is bumped to force-
  // remount the section inputs (resets local state of text fields, etc.).

  const handleConfigSave = useCallback(
    (patch: Partial<Config>) => {
      if (status === "running" || status === "pending") {
        // Never interrupt an active sort — save silently
        updateConfig(patch);
        return;
      }
      const hasResults = analysisResult !== null || previewResult !== null;
      if (hasResults) {
        setPendingConfigPatch(patch);
      } else {
        updateConfig(patch);
      }
    },
    [analysisResult, previewResult, status, updateConfig],
  );

  const handleConfigChangeConfirm = () => {
    if (pendingConfigPatch) updateConfig(pendingConfigPatch);
    setPendingConfigPatch(null);
    clearAnalysis();
    clearPreview();
    setStep(1);
  };

  const handleConfigChangeDismiss = () => {
    setPendingConfigPatch(null);
    setSectionBodyKey((k) => k + 1);
  };

  // ── Re-run (preview / sort) with confirmation ─────────────────────────────

  const handlePreviewClick = () => {
    if (previewResult !== null && !previewLoading) {
      setRerunConfirmType("preview");
    } else {
      void handlePreview();
    }
  };

  const handleSortClick = () => {
    if (report !== null && !isRunning) {
      setRerunConfirmType("sort");
    } else {
      void handleSort();
    }
  };

  const handleRerunConfirmed = async () => {
    const type = rerunConfirmType;
    setRerunConfirmType(null);
    if (type === "preview") {
      clearPreview();
      void handlePreview();
    } else if (type === "sort") {
      clearReport();
      void handleSort();
    }
  };

  // ── Backend status dot ─────────────────────────────────────────────────────

  const backendDotColor =
    health?.status === "ok"
      ? "bg-success"
      : healthLoading
        ? "bg-warning animate-pulse"
        : "bg-error";

  const backendLabel = health
    ? `Backend v${health.version}`
    : healthLoading
      ? "Connecting…"
      : "Backend unreachable";

  // ── HISTORY PAGE ───────────────────────────────────────────────────────────

  if (view === "history") {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-secondary dark:bg-background">
        {/* History-page header — completely replaces the wizard header */}
        <header className="relative shrink-0 border-b border-border bg-background px-6 py-3 shadow-sm">
          <TopProgressBar busy={globalBusy} />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setView("wizard")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Back to sort wizard"
              >
                <FiArrowLeft className="h-4 w-4" />
                Back
              </button>
              <div className="h-4 w-px bg-border" />
              <div className="flex items-center gap-2">
                <FiClock className="h-4 w-4 text-muted-foreground" />
                <span className="text-base font-semibold text-foreground">Sort History</span>
                {historyCount > 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
                    {historyCount}
                  </span>
                )}
              </div>
            </div>

            {/* Right: theme + backend status (same as wizard) */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggleTheme}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <FiSun className="h-4 w-4" /> : <FiMoon className="h-4 w-4" />}
              </button>
              <div className="flex items-center gap-1.5 text-xs">
                <span
                  className={cn("inline-block h-2 w-2 rounded-full shrink-0", backendDotColor)}
                />
                <span className="text-muted-foreground">{backendLabel}</span>
              </div>
            </div>
          </div>
        </header>

        {/* History content */}
        <main className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarGutter: "stable" }}>
          <div className="mx-auto max-w-3xl">
            <Suspense
              fallback={
                <div className="animate-pulse space-y-3 py-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-16 rounded-xl bg-muted" />
                  ))}
                </div>
              }
            >
              <HistoryPanel />
            </Suspense>
          </div>
        </main>
      </div>
    );
  }

  // ── WIZARD PAGE ────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-secondary dark:bg-background">
      {/* ── Wizard header ── */}
      <header className="relative shrink-0 border-b border-border bg-background px-6 py-3 shadow-sm">
        {/* App-wide "computing" indicator — very top of the window */}
        <TopProgressBar busy={globalBusy} />

        <div className="flex items-center justify-between">
          {/* Left: logo + version */}
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-foreground">MediaSorter</span>
            {health?.version && (
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                v{health.version}
              </span>
            )}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-3">
            {/* Theme toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <FiSun className="h-4 w-4" /> : <FiMoon className="h-4 w-4" />}
            </button>

            {/* History button → navigates to history page */}
            <button
              type="button"
              onClick={() => setView("history")}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FiClock className="h-3.5 w-3.5" />
              <span>History</span>
              {historyCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono tabular-nums">
                  {historyCount}
                </span>
              )}
            </button>

            {/* Backend status */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", backendDotColor)} />
              <span className="text-muted-foreground">{backendLabel}</span>
            </div>
          </div>
        </div>

        {/* Step indicator */}
        <StepIndicator
          current={step}
          doneSteps={doneSteps}
          maxReached={navigableUpTo}
          onStepClick={goToStep}
        />
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarGutter: "stable" }}>
        <div className={cn("mx-auto min-h-full space-y-4", contentWidth)}>
          {/* Update available banner */}
          {updateInfo?.update_available && <UpdateBanner info={updateInfo} />}

          {/* Backend warning banner */}
          {showBackendWarning && !health && (
            <div className="flex items-center gap-3 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm">
              <FiAlertTriangle className="shrink-0 h-4 w-4 text-warning" />
              <span className="text-warning">
                {isTauri ? (
                  "Lost connection to the MediaSorter engine. Reload to reconnect — if it keeps happening, restart the app."
                ) : (
                  <>
                    Cannot reach the backend. Make sure it&apos;s running (
                    <code className="mx-1 font-mono text-xs">make backend</code>) and try reloading.
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="ml-auto shrink-0 rounded-md border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning hover:bg-warning/25"
              >
                Reload
              </button>
            </div>
          )}

          {/* Keyed wrapper re-mounts on each step change so content animates in */}
          <div key={step} className="step-enter space-y-4">
            {/* ── Step 1: Configure ── */}
            {step === 1 && (
              <>
                {/* First-run welcome — shown once until dismissed */}
                {welcomeVisible && !config?.source_directory && (
                  <FirstRunWelcome onDismiss={dismissWelcome} />
                )}

                {/* Sidebar navigation stays usable during computation; only form inputs lock */}
                <ConfigPanel
                  disabled={isAnyRunning}
                  onSaveConfig={handleConfigSave}
                  sectionBodyKey={sectionBodyKey}
                />
              </>
            )}

            {/* ── Step 2: Analysis ── */}
            {step === 2 && (
              <>
                {analysisLoading && (
                  <div className="rounded-xl border border-border bg-card px-4 py-3">
                    <p className="text-sm font-medium text-foreground">Scanning source folder…</p>
                  </div>
                )}

                <AnalysisPanel
                  result={analysisResult}
                  loading={analysisLoading}
                  error={analysisError}
                  onRetry={() => void runAnalysis()}
                  onBackToConfig={() => setStep(1)}
                />

                {analysisResult && !analysisResult.disk_space.sufficient && !analysisLoading && (
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                    <FiXCircle className="shrink-0 h-4 w-4 text-error" />
                    <span>
                      Not enough disk space for copy. Free up space or switch to Move mode.
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto shrink-0"
                      onClick={() => setStep(1)}
                    >
                      ← Back to Config
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* ── Step 3: Preview ── */}
            {step === 3 && (
              <>
                {previewLoading && (
                  <PreviewProgressCard progress={previewProgress} elapsed={previewElapsed} />
                )}

                <PreviewPanel
                  result={previewResult}
                  loading={previewLoading}
                  error={previewError}
                  copyInsteadOfMove={config?.copy_instead_of_move}
                  categorizeEnabled={config?.categorize_enabled}
                  sortCriteria={config?.sort_criteria ?? ["year", "month", "day"]}
                />
              </>
            )}

            {/* ── Step 4: Sort ── */}
            {step === 4 && (
              <SortingProgress
                progress={progress ?? null}
                status={status}
                error={sortError}
                onCancel={handleCancelRequest}
                onViewReport={() => goToStep(5)}
                onRetry={() => void startSorting(false)}
              />
            )}

            {/* ── Step 5: Report ── */}
            {step === 5 && report && (
              <>
                <SortCelebration report={report} />
                <ReportPanel report={report} />
              </>
            )}
            {step === 5 && !report && (
              <div className="rounded-xl border border-border bg-muted/30 px-6 py-12 text-center">
                <p className="text-muted-foreground">
                  No report yet. Finish a sort to see results here.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Footer action bar ── */}
      <footer className="shrink-0 border-t border-border bg-background px-6 py-3">
        <div className={cn("mx-auto flex items-center justify-between gap-4", contentWidth)}>
          {/* Back — hidden on step 1 and step 5 */}
          {step > 1 && step !== 5 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToStep(Math.max(1, step - 1) as WizardStep)}
            >
              ← Back
            </Button>
          ) : (
            <div />
          )}

          {/* Global computation status — shown instead of per-step text */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
            {isAnyRunning ? (
              <div className="flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs">
                <FiLoader className="h-3 w-3 shrink-0 animate-spin text-primary" />
                <span className="font-medium text-foreground">
                  {analysisLoading && "Analyzing files…"}
                  {previewLoading &&
                    (previewProgress
                      ? `Preview: ${previewProgress.current.toLocaleString()} / ${previewProgress.total.toLocaleString()} files`
                      : `Computing preview… (${previewElapsed}s)`)}
                  {isRunning &&
                    (progress?.progress
                      ? `Sorting: ${progress.progress.current.toLocaleString()} / ${progress.progress.total.toLocaleString()} files`
                      : "Sorting files…")}
                </span>
                {cancellableOp && (
                  <button
                    type="button"
                    onClick={handleCancelRequest}
                    className="ml-1 rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                    title="Cancel current operation"
                    aria-label="Cancel current operation"
                  >
                    <FiXCircle className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {step === 4 &&
                  status === "completed" &&
                  !isRunning &&
                  "Sort complete — view the report."}
                {step === 4 && status === "failed" && "Sort failed. Check the logs below."}
                {step === 5 && report && "Sort complete. Export or start a new sort."}
              </p>
            )}
          </div>

          {/* Forward actions */}
          <div className="flex gap-2">
            {/* Universal "Next" ghost button — visible on any step when a later step has
                been computed or is actively computing, so the user can always navigate
                forward without waiting for the primary action to complete. */}
            {navigableUpTo > step && step < 4 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToStep((step + 1) as WizardStep)}
                className="flex items-center gap-1"
                title="Go to next step"
              >
                Next <FiArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}

            {step === 1 && (
              <Button
                size="sm"
                disabled={!canGoToAnalysis || isAnyRunning || !health}
                title={
                  !health
                    ? "Backend not connected"
                    : isAnyRunning
                      ? "Wait for current operation to finish"
                      : !canGoToAnalysis
                        ? "Fix the highlighted settings first"
                        : undefined
                }
                onClick={() => void handleAnalyse()}
              >
                Analyze →
              </Button>
            )}

            {step === 2 && (
              <Button
                size="sm"
                disabled={!canGoToPreview || isAnyRunning}
                title={
                  isAnyRunning
                    ? "Wait for current operation to finish"
                    : !canGoToPreview
                      ? analysisError
                        ? "Analysis failed — retry first"
                        : "Analysis must complete with sufficient disk space"
                      : previewResult !== null
                        ? "Re-run preview (will discard existing preview)"
                        : undefined
                }
                onClick={handlePreviewClick}
              >
                {previewResult !== null && !previewLoading ? "Re-run Preview" : "Run Preview →"}
              </Button>
            )}

            {step === 3 && (
              <Button
                size="sm"
                disabled={!canGoToSort || isAnyRunning}
                title={
                  isAnyRunning
                    ? "Wait for current operation to finish"
                    : !canGoToSort
                      ? "Generate a preview first"
                      : report !== null
                        ? "Re-run sort (will start a new sort)"
                        : undefined
                }
                onClick={handleSortClick}
              >
                Sort Now →
              </Button>
            )}

            {step === 4 && !isRunning && status === "completed" && (
              <Button size="sm" onClick={() => goToStep(5)}>
                View Report →
              </Button>
            )}

            {step === 5 && (
              <Button variant="outline" size="sm" onClick={handleNewSort}>
                New Sort
              </Button>
            )}
          </div>
        </div>
      </footer>

      {/* ── Log viewer ── */}
      <LogViewer isRunning={isAnyRunning} />

      {/* Config-change confirmation dialog */}
      <ConfirmDialog
        open={pendingConfigPatch !== null}
        title="Apply setting and reset results?"
        description="Changing settings will immediately discard your current analysis and preview. You'll need to re-run them before sorting."
        confirmLabel="Apply & reset"
        cancelLabel="Cancel"
        onClose={handleConfigChangeDismiss}
        onConfirm={handleConfigChangeConfirm}
      >
        {(analysisResult || previewResult) && (
          <ul className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {analysisResult && (
              <li>
                Analysis:{" "}
                <span className="font-semibold text-foreground">
                  {analysisResult.total_files.toLocaleString()} files scanned
                </span>
              </li>
            )}
            {previewResult && (
              <li>
                Preview:{" "}
                <span className="font-semibold text-foreground">
                  {previewResult.items.length.toLocaleString()} items planned
                </span>
              </li>
            )}
          </ul>
        )}
      </ConfirmDialog>

      {/* Re-run confirmation dialog */}
      <ConfirmDialog
        open={rerunConfirmType !== null}
        title={rerunConfirmType === "preview" ? "Re-run preview?" : "Re-run sort?"}
        description={
          rerunConfirmType === "preview"
            ? "This will discard the current preview and compute a new one. Any changes you reviewed will be lost."
            : "This will start a new sort. The previous sort report will be discarded."
        }
        confirmLabel={rerunConfirmType === "preview" ? "Re-run Preview" : "Re-run Sort"}
        cancelLabel="Keep existing"
        onClose={() => setRerunConfirmType(null)}
        onConfirm={() => void handleRerunConfirmed()}
      />

      {/* Cancel confirmation dialog */}
      <ConfirmDialog
        open={cancelConfirmOpen}
        title={`Cancel ${cancellableOp === "preview" ? "preview" : "sort"}?`}
        description={
          cancellableOp === "preview"
            ? "The preview computation will be cancelled and progress will be lost. You can re-run it afterwards."
            : "The sort will stop. Files already processed remain in their new location and a partial report will be shown."
        }
        confirmLabel="Yes, cancel"
        cancelLabel="Keep going"
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={() => void handleCancelConfirmed()}
      />
    </div>
  );
}
