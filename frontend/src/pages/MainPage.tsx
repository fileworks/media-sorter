/**
 * The application: one window, four screens, one primary action at a time.
 *
 * This file owns the wiring — server state, the folder list, the run — and
 * nothing about presentation. Each screen is handed exactly the data it draws
 * and exactly the callbacks it can fire, which is what keeps "can I press
 * Execute?" answerable in one place (`stageModel`) rather than in four.
 *
 * The one flow decision that lives here: Configure's primary action runs the
 * scan and the dry run, then moves to Review. Review is the plan, so there is
 * nothing to review until that has happened, and making the user press "scan"
 * and then "preview" as two separate acts was asking them to know why.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiArrowLeft } from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { ExecutePreflight } from "@/components/OperationCenter";
import { RecoveryBanner } from "@/components/RecoveryBanner";
import { StageShell, type StageNav } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { StageFooter } from "@/components/shell/StageFooter";
import { TitleBar, type BackendState } from "@/components/shell/TitleBar";
import { ConfigureScreen } from "@/components/screens/ConfigureScreen";
import { ExecuteScreen } from "@/components/screens/ExecuteScreen";
import { RecipeScreen } from "@/components/screens/RecipeScreen";
import { ReviewPlanLifecycle } from "@/components/screens/ReviewPlanLifecycle";
import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { RunLog } from "@/components/screens/RunLog";
import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/toast-context";
import { useAnalysis } from "@/hooks/useAnalysis";
import { usePlanImpact } from "@/hooks/usePlanImpact";
import { useConfig } from "@/hooks/useConfig";
import { useConfigDefaults } from "@/hooks/useConfigDefaults";
import { useGlobalLoader } from "@/hooks/useGlobalLoader";
import { useLogs } from "@/hooks/useLogs";
import { useRootProbes } from "@/hooks/useRootProbes";
import { usePreview } from "@/hooks/usePreview";
import { useSorting } from "@/hooks/useSorting";
import { useTheme } from "@/hooks/useTheme";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useI18n, type Locale } from "@/i18n/I18nContext";
import { splitValidation } from "@/lib/configGates";
import { sampleFiles } from "@/lib/configSummary";
import { extractErrorMessage } from "@/lib/errorUtils";
import {
  EMPTY_RUN_DECISIONS,
  sameReviewedSets,
  type ReviewDecisionUpdate,
  type RunDecisions,
} from "@/lib/runDecisions";
import type { RootCard, RootRole } from "@/lib/sourcesStage";
import { activeCards, blockingConflicts, rootCards, validateRoots } from "@/lib/sourcesStage";
import { stageComplete, type StageInputs, type StageKey, type StageState } from "@/lib/stageModel";
import { startBlock } from "@/lib/startupRecovery";
import { isTauri } from "@/lib/utils";
import { invalidationForConfigPatch } from "@/lib/workflowInvalidation";
import { api } from "@/services/api";
import type { Config, ConfigIssue, RecipeSettings } from "@/types/api";

const HistoryPanel = lazy(() =>
  import("@/components/HistoryPanel").then((module) => ({ default: module.HistoryPanel })),
);
const FinishedRun = lazy(() =>
  import("@/components/screens/FinishedRun").then((module) => ({ default: module.FinishedRun })),
);

/** What a folder request is for: a new root in a role, or an existing one. */
type FolderTarget = { kind: "add"; role: RootRole } | { kind: "change"; rootId: string };

export default function MainPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { theme, toggle: toggleTheme } = useTheme();
  const { config, validationErrors, updateConfig, saveError, retrySave } = useConfig();
  const { setLocale, locale, t } = useI18n();

  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  const [excludedForRun, setExcludedForRun] = useState<string[]>([]);
  const [stage, setStage] = useState<StageState["stage"]>("sources");
  const [requestedStage, setRequestedStage] = useState<StageState["stage"] | null>(null);
  const [pendingSettingAnchor, setPendingSettingAnchor] = useState<string | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<FolderTarget | null>(null);
  // What Review decided for this run. Lifted here so Execute sends it, and so
  // the preflight can ask the plan what those decisions leave.
  const [runDecisions, setRunDecisions] = useState<RunDecisions>(EMPTY_RUN_DECISIONS);
  const resumedTaskRef = useRef<string | null>(null);

  const configDefaults = useConfigDefaults();
  const analysis = useAnalysis();
  const preview = usePreview();
  const sorting = useSorting();
  const loaderActive = useGlobalLoader();
  const { logs } = useLogs();
  const { data: updateInfo } = useUpdateCheck();

  const {
    data: health,
    isLoading: healthLoading,
    isError: healthError,
  } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 10_000,
    retry: 3,
  });
  const { data: historyMeta } = useQuery({
    queryKey: ["reports", 1, 0],
    queryFn: () => api.listReports(1, 0),
    enabled: health?.status === "ok",
    staleTime: 30_000,
  });
  const { data: diagnostics } = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => api.diagnostics(),
    enabled: health?.status === "ok",
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (config?.language) setLocale(config.language);
  }, [config?.language, setLocale]);

  useEffect(() => setImpactAcknowledged(false), [preview.result]);

  const scanned = analysis.result !== null && analysis.error === null;
  const planned = preview.result !== null && preview.error === null;
  const isSorting = sorting.status === "running" || sorting.status === "pending";
  const activeTask = diagnostics?.active_task ?? null;
  const externalTaskActive =
    activeTask !== null && !["analysis", "preview", "sort"].includes(activeTask.operation_kind);
  const isAnyRunning = analysis.loading || preview.loading || isSorting || externalTaskActive;
  const recoveryOperations = useMemo(() => diagnostics?.recovery_operations ?? [], [diagnostics]);
  const recoveryBlock = startBlock(recoveryOperations);

  // Background work belongs to the backend process, not this component. A UI
  // reload reattaches to the task identity reported by diagnostics and resumes
  // the ordinary status transport instead of presenting a fresh, executable
  // workflow over work that is still running.
  useEffect(() => {
    if (!activeTask) {
      resumedTaskRef.current = null;
      return;
    }
    if (
      resumedTaskRef.current === activeTask.task_id ||
      analysis.taskId === activeTask.task_id ||
      preview.taskId === activeTask.task_id ||
      sorting.taskId === activeTask.task_id ||
      analysis.loading ||
      preview.loading ||
      isSorting
    ) {
      return;
    }
    if (activeTask.operation_kind === "analysis") {
      resumedTaskRef.current = activeTask.task_id;
      analysis.resumeAnalysis(activeTask.task_id);
      setRequestedStage("review");
    } else if (activeTask.operation_kind === "preview") {
      resumedTaskRef.current = activeTask.task_id;
      preview.resumePreview(activeTask.task_id);
      setRequestedStage("review");
    } else if (activeTask.operation_kind === "sort") {
      resumedTaskRef.current = activeTask.task_id;
      sorting.resumeSorting(activeTask.task_id, activeTask.status);
      setRequestedStage("execute");
    }
  }, [activeTask, analysis, analysis.loading, isSorting, preview, preview.loading, sorting]);

  const configuredCards = useMemo(
    () => rootCards(config, scanned, analysis.result?.total_files ?? 0),
    [analysis.result?.total_files, config, scanned],
  );
  // The probe is the authority on whether a folder is usable; the scan only
  // knows what it saw last time it ran.
  const probes = useRootProbes(configuredCards);
  const cards = useMemo(
    () => configuredCards.map((card) => ({ ...card, state: probes[card.rootId] ?? card.state })),
    [configuredCards, probes],
  );

  // ── Configuration ──────────────────────────────────────────────────────────

  const planExists = preview.result !== null;

  // The Configure previews are drawn with the user's own files once a dry run
  // has produced any. A scan reports totals but no filenames, so the dry run is
  // the first moment real names exist.
  const configureSamples = useMemo(
    () => sampleFiles(preview.result?.items ?? []),
    [preview.result?.items],
  );

  /**
   * Settings are written straight through.
   *
   * This used to intercept every patch while a plan existed and raise a modal
   * asking whether to discard it — a per-field answer to a per-session question.
   * Six edits meant six identical dialogs, and the plan was destroyed on the
   * first answer, so the remaining five asked about a plan that was already
   * gone. The stage lock replaces all of it: while a plan exists the settings
   * cannot be reached at all, and unlocking asks once.
   */
  /** Invalidate only artifacts downstream of a still-valid scan. */
  const discardPlan = useCallback(() => {
    preview.clear();
    setRunDecisions(EMPTY_RUN_DECISIONS);
    setImpactAcknowledged(false);
  }, [preview]);

  /** Source scope and traversal changes also invalidate the scan itself. */
  const discardScan = useCallback(() => {
    analysis.clear();
    discardPlan();
  }, [analysis, discardPlan]);

  const handleConfigSave = useCallback(
    (patch: Partial<Config>) => {
      const invalidation = invalidationForConfigPatch(patch);
      if (invalidation === "scan") discardScan();
      else if (invalidation === "preview") discardPlan();
      updateConfig(patch);
    },
    [discardPlan, discardScan, updateConfig],
  );

  /** Applying a recipe rewrites the settings the plan was built from. */
  const handleRecipeApply = useCallback(
    (patch: Partial<Config>) => {
      handleConfigSave(patch);
    },
    [handleConfigSave],
  );

  const handleRootsChange = useCallback(
    (nextCards: RootCard[]) => {
      if (!config) return;
      const roots = nextCards.map((card) => {
        const existing = config.library_profile.roots.find((root) => root.root_id === card.rootId);
        return {
          root_id: card.rootId,
          role: card.role,
          path: card.path,
          display_name: card.displayName,
          priority: card.priority,
          exclusions: card.exclusions,
          identity: existing?.identity ?? null,
        };
      });
      handleConfigSave({
        source_directory: roots.find((root) => root.role === "input")?.path ?? "",
        target_directory: roots.find((root) => root.role === "destination")?.path ?? "",
        library_profile: { ...config.library_profile, roots },
      });
    },
    [config, handleConfigSave],
  );

  /** Where a chosen path lands: appended as a new root, or replacing one. */
  const applyFolder = useCallback(
    (target: FolderTarget, path: string) => {
      if (target.kind === "change") {
        handleRootsChange(
          cards.map((card) =>
            card.rootId === target.rootId ? { ...card, path, volume: null } : card,
          ),
        );
        return;
      }
      handleRootsChange([
        ...cards,
        {
          rootId: `${target.role}-${Date.now()}`,
          role: target.role,
          path,
          displayName: null,
          // Priority is no longer written: the reorder controls are gone and
          // nothing consumes the order. The field stays in the model.
          priority: 0,
          exclusions: [],
          state: "unknown",
          volume: null,
          freshness: "unknown",
          indexedFiles: null,
          issueCount: 0,
        },
      ]);
    },
    [cards, handleRootsChange],
  );

  /**
   * Ask for a folder. The desktop shell has the OS picker; a browser gets the
   * folder browser, which lists through the same endpoint that validates a
   * root. Both paths land in `applyFolder`, so the two builds cannot diverge.
   */
  const requestFolder = useCallback(
    async (target: FolderTarget) => {
      if (!isTauri) {
        setFolderPrompt(target);
        return;
      }
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === "string") applyFolder(target, selected);
      } catch {
        toast(t("sources.folderPickerFailed"), "error");
      }
    },
    [applyFolder, t, toast],
  );

  const removeFolder = useCallback(
    (rootId: string) => handleRootsChange(cards.filter((card) => card.rootId !== rootId)),
    [cards, handleRootsChange],
  );

  // ── Recipes ────────────────────────────────────────────────────────────────

  const { data: savedRecipes = [] } = useQuery({
    queryKey: ["recipes"],
    queryFn: () => api.listRecipes(),
    enabled: health?.status === "ok",
    staleTime: 60_000,
  });

  const saveRecipe = useMutation({
    mutationFn: ({ name, settings }: { name: string; settings: RecipeSettings }) =>
      api.saveRecipe(name, settings),
    onSuccess: (recipe) => {
      void queryClient.invalidateQueries({ queryKey: ["recipes"] });
      toast(t("recipes.saved", { name: recipe.name }), "success");
    },
  });

  const deleteRecipe = useMutation({
    mutationFn: (recipeId: string) => api.deleteRecipe(recipeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
    onError: () => toast(t("recipes.deleteFailed"), "error"),
  });

  // ── Gates ──────────────────────────────────────────────────────────────────

  /** A validation issue as the one sentence the user reads. */
  const issueText = useCallback(
    (issue: ConfigIssue) => t(issue.message_key, issue.params, issue.message),
    [t],
  );

  // Two gates, not one. A folder problem stops the flow at Sources, where it can
  // be fixed; a settings problem stops it at Configure, for the same reason.
  // Reporting either as the other is how somebody ends up on a screen that says
  // to choose folders they have already chosen.
  const { roots: rootIssues, settings: settingIssues } = useMemo(
    () => splitValidation(validationErrors),
    [validationErrors],
  );
  const activeRootCards = useMemo(
    () => activeCards(cards, excludedForRun),
    [cards, excludedForRun],
  );
  const rootConflicts = useMemo(() => validateRoots(activeRootCards), [activeRootCards]);
  // The client-side conflict is named first: it is computed from the cards on
  // screen, so it is both more specific and never a round-trip behind them.
  const rootBlocker = blockingConflicts(rootConflicts)[0];
  // Saved-profile validation still sees roots deliberately omitted from this
  // run. Once scope is narrowed, active-card validation and the scoped backend
  // operation are authoritative; otherwise an offline skipped drive would keep
  // blocking the very escape hatch intended for it.
  const rootIssue = excludedForRun.length === 0 ? (rootIssues[0] ?? null) : null;
  const settingIssue = settingIssues[0] ?? null;
  const rootsReady = !rootBlocker && rootIssue === null;

  // ── The run ────────────────────────────────────────────────────────────────

  /**
   * Scan and plan in one act, then hand back whether there is a plan.
   *
   * Splitting these into two buttons made the user responsible for knowing that
   * a dry run needs a fresh index. It does; that is our problem, not theirs.
   *
   * Both steps are awaited to *completion*, not to "started": the backend runs
   * one operation at a time and rejects the second with a 409. Starting the dry
   * run the moment the scan had been queued meant the button did nothing at all
   * on a fast scan, silently, which is the worst version of that.
   */
  const buildPlan = useCallback(async (): Promise<boolean> => {
    if (recoveryBlock.blocked) {
      toast(recoveryBlock.reason ?? t("stage.recovery.blocked"), "warning");
      return false;
    }
    // Whichever gate is closed, the toast says which one — the backend would
    // refuse the plan for exactly this reason, and repeating a generic folder
    // warning for a settings problem sends the user to the wrong screen.
    const blocker = rootIssue ?? settingIssue;
    if (rootBlocker) {
      toast(
        t(`sources.conflict.${rootBlocker.kind}`, rootBlocker.params, rootBlocker.message),
        "warning",
      );
      return false;
    }
    if (blocker) {
      toast(issueText(blocker), "warning");
      return false;
    }
    if (!analysis.result) {
      preview.clear();
      // A failure or cancellation is surfaced on Review; pressing on would
      // plan on nothing.
      if (!(await analysis.runAnalysis(excludedForRun))) return false;
    }
    setRunDecisions(EMPTY_RUN_DECISIONS);
    return (await preview.generatePreview(excludedForRun)) !== null;
  }, [
    analysis,
    excludedForRun,
    issueText,
    preview,
    recoveryBlock,
    rootBlocker,
    rootIssue,
    settingIssue,
    t,
    toast,
  ]);

  const cancellableOperation = analysis.loading
    ? "analysis"
    : preview.loading
      ? "preview"
      : isSorting
        ? "sort"
        : null;

  const cancelCurrent = async () => {
    setCancelConfirmOpen(false);
    if (cancellableOperation === "analysis") await analysis.cancelAnalysis();
    if (cancellableOperation === "preview") await preview.cancelPreview();
    if (cancellableOperation === "sort") await sorting.cancelSorting();
  };

  /**
   * Put the application back at Sources, ready for a second run.
   *
   * Clears everything scoped to the finished run — the report, the analysis,
   * the preview and Review's decisions — and leaves configuration alone. A
   * fresh run therefore requires a fresh preview, which is what the stage gates
   * already enforce once the plan is gone.
   */
  const startNewRun = useCallback(() => {
    sorting.clearReport();
    analysis.clear();
    preview.clear();
    setExcludedForRun([]);
    setRunDecisions(EMPTY_RUN_DECISIONS);
    setImpactAcknowledged(false);
    setRequestedStage("sources");
  }, [analysis, preview, sorting]);

  const startRun = useCallback(() => {
    if (runDecisions.planId !== preview.result?.plan_id || runDecisions.outstandingSets !== 0) {
      return;
    }
    void sorting.startSorting(false, preview.result?.config_fingerprint, preview.result?.plan_id, {
      excludedRoots: excludedForRun,
      reviewedSets: runDecisions.reviewedSets,
    });
  }, [excludedForRun, preview.result, runDecisions, sorting]);

  // ── Stage wiring ───────────────────────────────────────────────────────────

  // Both objects are read by `StageShell` from an effect and a memo, so their
  // identity is load-bearing: rebuilding them every render re-ran reconciliation
  // on every render, which is a re-render loop, not a re-render.
  const stageInputs = useMemo<StageInputs>(
    () => ({
      rootsReady,
      rootsReason: rootBlocker
        ? t(`sources.conflict.${rootBlocker.kind}`, rootBlocker.params, rootBlocker.message)
        : rootIssue
          ? issueText(rootIssue)
          : null,
      scanned,
      planned,
      plannedReason: t("stage.gate.plan"),
      duplicateReviewReady:
        runDecisions.planId === preview.result?.plan_id && runDecisions.outstandingSets === 0,
      duplicateReviewReason:
        runDecisions.planId !== preview.result?.plan_id || runDecisions.outstandingSets === null
          ? t("stage.gate.duplicateLoading")
          : t("stage.gate.duplicates", { count: runDecisions.outstandingSets }),
      executionActive: isSorting || activeTask?.operation_kind === "sort",
      blocked: recoveryBlock.blocked,
      blockedReason: recoveryBlock.reason,
    }),
    [
      issueText,
      activeTask?.operation_kind,
      isSorting,
      planned,
      recoveryBlock.blocked,
      recoveryBlock.reason,
      rootBlocker,
      rootIssue,
      rootsReady,
      runDecisions.outstandingSets,
      runDecisions.planId,
      scanned,
      t,
      preview.result?.plan_id,
    ],
  );

  const stageKey = useMemo<StageKey>(
    () => ({
      profileId: config?.library_profile.profile_id ?? "",
      catalogGeneration: scanned ? analysis.generation : 0,
      planVersion: planned ? preview.generation : 0,
      taskId: sorting.taskId ?? preview.taskId ?? analysis.taskId,
    }),
    [
      analysis.generation,
      analysis.taskId,
      config?.library_profile.profile_id,
      planned,
      preview.generation,
      preview.taskId,
      scanned,
      sorting.taskId,
    ],
  );

  // The preflight asks the scoped plan for exactly what will happen after the
  // duplicate confirmations on Review.
  const runImpact = usePlanImpact(
    preview.result?.plan_id,
    excludedForRun,
    runDecisions.reviewedSets,
  );
  const impact = runImpact.data ?? preview.result?.impact;

  // Review publishes its derived decision wire from an effect. Keep this
  // boundary stable and ignore a byte-identical publication; an inline
  // callback made the effect publish, rerender MainPage, receive a new callback
  // and publish forever in a real run.
  const publishRunDecisions = useCallback(
    (decisions: ReviewDecisionUpdate) => {
      const planId = preview.result?.plan_id ?? null;
      setRunDecisions((current) =>
        current.planId === planId &&
        current.outstandingSets === decisions.outstandingSets &&
        current.proposedSets === decisions.proposedSets &&
        current.undecidedSets === decisions.undecidedSets &&
        sameReviewedSets(current.reviewedSets, decisions.reviewedSets)
          ? current
          : { ...decisions, planId },
      );
    },
    [preview.result?.plan_id],
  );
  const preflightInput = {
    actionableGroups: impact?.actionable_groups ?? 0,
    quarantineCount: impact?.quarantine_count ?? 0,
    quarantineBytes: impact?.quarantine_bytes ?? 0,
    copyCount: impact?.copy_count ?? 0,
    moveCount: impact?.move_count ?? 0,
    skipCount: impact?.skip_count ?? 0,
    referenceCount: 0,
    sourceMutations: impact?.source_mutations ?? 0,
    acknowledgedSourceMutations: impactAcknowledged,
    staleGroups: 0,
    unresolvedGroups: impact?.unresolved_count ?? 0,
    unplannedCount: impact?.unresolved_count ?? 0,
    freeBytes: analysis.result?.disk_space.destination_free_bytes ?? null,
    requiredBytes: impact?.required_bytes ?? 0,
    quarantineWritable: true,
    conversionWithoutOriginals: impact?.conversion_without_originals ?? 0,
    companionsLeftInPlace: impact?.companions_left_in_place ?? 0,
    embeddedTagCount: impact?.embedded_tag_count ?? 0,
  };

  /** Jump to Configure and scroll to a named setting row once it has mounted. */
  const openSetting = useCallback((anchorId: string, nav: StageNav) => {
    setPendingSettingAnchor(anchorId);
    nav.go("configure");
  }, []);

  useEffect(() => {
    if (stage !== "configure" || !pendingSettingAnchor) return;
    const id = window.setTimeout(() => {
      document.getElementById(pendingSettingAnchor)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      setPendingSettingAnchor(null);
    }, 80);
    return () => window.clearTimeout(id);
  }, [pendingSettingAnchor, stage]);

  const backendState: BackendState =
    health?.status === "ok"
      ? "ready"
      : healthError
        ? "lost"
        : healthLoading
          ? "connecting"
          : "connecting";

  const titleBar = (
    <TitleBar
      runLabel={t(
        isSorting
          ? "app.runInProgress"
          : sorting.report
            ? "app.runFinished"
            : planned
              ? "app.runPlanned"
              : "app.newRun",
      )}
      backend={backendState}
      version={health?.version ?? null}
      theme={theme}
      onToggleTheme={toggleTheme}
      locale={locale}
      onLocaleChange={(next: Locale) => {
        setLocale(next);
        handleConfigSave({ language: next });
      }}
      historyCount={historyMeta?.total ?? 0}
      onOpenHistory={() => setHistoryOpen(true)}
      busy={isAnyRunning || loaderActive}
    />
  );

  const saveFailure = saveError ? extractErrorMessage(saveError, t("config.saveFailedHelp")) : null;

  const banners = (
    <>
      {recoveryOperations.map((operation) => (
        <RecoveryBanner
          key={operation.operation_id}
          operation={operation}
          onOpenReport={() => setHistoryOpen(true)}
        />
      ))}
      {updateInfo?.update_available && <UpdateBanner info={updateInfo} />}
      {healthError && (
        <StateView
          variant="error"
          compact
          title={isTauri ? t("backend.lost") : t("backend.browserLost")}
          action={
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-current px-3 py-1 text-xs"
            >
              {t("app.reload")}
            </button>
          }
        />
      )}
      {saveFailure && (
        <StateView
          variant="error"
          compact
          title={t("config.saveFailed")}
          detail={saveFailure.message}
          code={saveFailure.code}
          onRetry={retrySave}
        />
      )}
      {externalTaskActive && (
        <StateView variant="loading" compact title={t("app.activeBackgroundTask")} />
      )}
    </>
  );

  // ── History is a separate place, not a stage ───────────────────────────────

  if (historyOpen) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {titleBar}
        <div className="border-b border-border bg-card px-4 py-2.5 sm:px-5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHistoryOpen(false)}
            className="text-muted-foreground"
          >
            <FiArrowLeft className="h-4 w-4" aria-hidden />
            {t("app.back")}
          </Button>
        </div>
        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <Suspense
              fallback={<StateView variant="loading" layout="page" title={t("state.loading")} />}
            >
              <HistoryPanel />
            </Suspense>
          </div>
        </main>
      </div>
    );
  }

  return (
    <>
      <StageShell
        inputs={stageInputs}
        stageKey={stageKey}
        requestedStage={requestedStage}
        titleBar={titleBar}
        banners={banners}
        planExists={planExists}
        onUnlock={discardPlan}
        complete={(candidate) => stageComplete(candidate, stageInputs, sorting.report !== null)}
        onStateChange={(state) => {
          setStage(state.stage);
          if (state.stage === requestedStage) setRequestedStage(null);
        }}
        footer={(state, nav) => (
          <StageFooter
            stage={state.stage}
            nav={nav}
            analysis={analysis.result}
            busy={analysis.loading || preview.loading}
            previewReady={{
              ok: rootsReady && settingIssue === null && !isAnyRunning,
              reason: !rootsReady
                ? stageInputs.rootsReason
                : settingIssue
                  ? issueText(settingIssue)
                  : isAnyRunning
                    ? t("footer.busy")
                    : null,
            }}
            onPreview={() => {
              // Review owns both the computation and its result. Move first so
              // the first visible state is progress, then replace it in place.
              nav.go("review");
              void buildPlan();
            }}
          />
        )}
      >
        {(state, nav) => {
          if (state.stage === "sources") {
            return config ? (
              <SourcesScreen
                cards={cards}
                excludedForRun={excludedForRun}
                analysis={analysis.result}
                config={config}
                disabled={isAnyRunning}
                onChange={handleRootsChange}
                onExcludeForRun={(next) => {
                  setExcludedForRun(next);
                  discardScan();
                }}
                onAddFolder={(role) => void requestFolder({ kind: "add", role })}
                onChangeFolder={(rootId) => void requestFolder({ kind: "change", rootId })}
                onRemove={removeFolder}
              />
            ) : (
              <StateView variant="loading" layout="page" title={t("state.loading")} />
            );
          }

          if (state.stage === "recipe") {
            return config ? (
              <RecipeScreen
                config={config}
                savedRecipes={savedRecipes}
                onApply={handleRecipeApply}
                onDelete={(recipeId: string) => deleteRecipe.mutate(recipeId)}
                disabled={isAnyRunning}
                planExists={planExists}
                defaults={configDefaults}
              />
            ) : (
              <StateView variant="loading" layout="page" title={t("state.loading")} />
            );
          }

          if (state.stage === "configure") {
            return (
              <ConfigureScreen
                disabled={isAnyRunning}
                onSaveConfig={handleConfigSave}
                onSaveRecipe={async (name, settings) => {
                  await saveRecipe.mutateAsync({ name, settings });
                }}
                savedRecipes={savedRecipes}
                onEditRecipe={() => nav.go("recipe")}
                samples={configureSamples}
              />
            );
          }

          if (state.stage === "review") {
            return (
              <ReviewPlanLifecycle
                analysis={analysis}
                preview={preview}
                ready={Boolean(preview.result && config)}
                onCancel={() => setCancelConfirmOpen(true)}
                onRetry={() => void buildPlan()}
              >
                {preview.result && config ? (
                  <ReviewScreen
                    result={preview.result}
                    config={config}
                    onOpenSetting={(anchorId) => openSetting(anchorId, nav)}
                    onOpenSources={() => nav.go("sources")}
                    onRerunPreview={() => {
                      setRunDecisions(EMPTY_RUN_DECISIONS);
                      void preview.generatePreview(excludedForRun);
                    }}
                    onDecisionsChange={publishRunDecisions}
                  />
                ) : null}
              </ReviewPlanLifecycle>
            );
          }

          // Execute.
          if (!config)
            return <StateView variant="loading" layout="page" title={t("state.loading")} />;
          if (sorting.report) {
            return (
              <Suspense
                fallback={<StateView variant="loading" layout="page" title={t("state.loading")} />}
              >
                <FinishedRun
                  report={sorting.report}
                  onStartNewRun={startNewRun}
                  onOpenHistory={() => setHistoryOpen(true)}
                />
              </Suspense>
            );
          }
          if (sorting.status === "idle") {
            // The other three screens open with a heading; this one used to
            // start at a card, which also left `<main>`'s `aria-labelledby`
            // pointing at nothing on the one screen that decides to move files.
            return (
              <div className="mx-auto max-w-2xl">
                <ScreenHeader title={t("preflight.title")} subtitle={t("preflight.description")} />
                <ExecutePreflight
                  input={preflightInput}
                  onAcknowledge={setImpactAcknowledged}
                  onExecute={startRun}
                  busy={isSorting}
                />
              </div>
            );
          }
          return (
            <ExecuteScreen
              status={sorting.status === "pending" ? "running" : sorting.status}
              progress={sorting.progress?.progress ?? null}
              outcomes={sorting.progress?.progress?.outcomes ?? {}}
              error={sorting.error}
              config={config}
              reportPath={null}
              reportLoading={sorting.reportLoading}
              onCancel={() => setCancelConfirmOpen(true)}
              onRetry={sorting.canRetryStart ? startRun : undefined}
              onRetryReport={
                sorting.operationId && sorting.error && !sorting.reportLoading
                  ? sorting.retryReport
                  : undefined
              }
              onStartNewRun={startNewRun}
              onOpenHistory={() => setHistoryOpen(true)}
            >
              <RunLog entries={logs} running={isSorting} />
            </ExecuteScreen>
          );
        }}
      </StageShell>

      <FolderBrowserDialog
        open={folderPrompt !== null}
        initialPath={
          folderPrompt?.kind === "change"
            ? (cards.find((card) => card.rootId === folderPrompt.rootId)?.path ?? "")
            : ""
        }
        requireWritable={
          folderPrompt?.kind === "change"
            ? cards.find((card) => card.rootId === folderPrompt.rootId)?.role === "destination"
            : folderPrompt?.role === "destination"
        }
        onSelect={(path) => folderPrompt && applyFolder(folderPrompt, path)}
        onClose={() => setFolderPrompt(null)}
      />

      <ConfirmDialog
        open={cancelConfirmOpen}
        title={t(
          cancellableOperation === "analysis"
            ? "dialog.cancelAnalysis.title"
            : cancellableOperation === "preview"
              ? "dialog.cancelPreview.title"
              : "dialog.cancelSort.title",
        )}
        description={t(
          cancellableOperation === "analysis"
            ? "dialog.cancelAnalysis.description"
            : cancellableOperation === "preview"
              ? "dialog.cancelPreview.description"
              : "dialog.cancelSort.description",
        )}
        confirmLabel={t("dialog.yesCancel")}
        cancelLabel={t("dialog.keepGoing")}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={() => void cancelCurrent()}
      />
    </>
  );
}
