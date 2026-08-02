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

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiArrowLeft } from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ExecutePreflight } from "@/components/OperationCenter";
import { PreviewProgressCard } from "@/components/PreviewProgressCard";
import { RecoveryBanner } from "@/components/RecoveryBanner";
import { StageShell, type StageNav } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ActionBar } from "@/components/shell/ActionBar";
import { TitleBar, type BackendState } from "@/components/shell/TitleBar";
import { ConfigureScreen } from "@/components/screens/ConfigureScreen";
import { ExecuteScreen } from "@/components/screens/ExecuteScreen";
import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { RunLog } from "@/components/screens/RunLog";
import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/toast-context";
import { useAnalysis } from "@/hooks/useAnalysis";
import { useConfig } from "@/hooks/useConfig";
import { useGlobalLoader } from "@/hooks/useGlobalLoader";
import { useLogs } from "@/hooks/useLogs";
import { usePreview } from "@/hooks/usePreview";
import { useSorting } from "@/hooks/useSorting";
import { useTheme } from "@/hooks/useTheme";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useI18n, type Locale } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { formatBytes, formatDuration } from "@/lib/formatters";
import type { RootCard, RootRole } from "@/lib/sourcesStage";
import { blockingConflicts, validateRoots } from "@/lib/sourcesStage";
import type { StageState, View } from "@/lib/stageModel";
import { startBlock } from "@/lib/startupRecovery";
import { isTauri } from "@/lib/utils";
import { api } from "@/services/api";
import type { Config, OperationReport, RecipeSettings } from "@/types/api";

const HistoryPanel = lazy(() =>
  import("@/components/HistoryPanel").then((module) => ({ default: module.HistoryPanel })),
);
const ReportPanel = lazy(() =>
  import("@/components/ReportPanel").then((module) => ({ default: module.ReportPanel })),
);

/** The library profile's roots, presented as the cards the Sources screen draws. */
function rootCards(config: Config | undefined, scanned: boolean, indexedFiles: number): RootCard[] {
  if (!config) return [];
  const profileRoots =
    config.library_profile.roots.length > 0
      ? config.library_profile.roots
      : [
          ...(config.source_directory
            ? [
                {
                  root_id: "legacy-input",
                  role: "input" as const,
                  path: config.source_directory,
                  display_name: null,
                  priority: 0,
                  exclusions: [],
                  identity: null,
                },
              ]
            : []),
          ...(config.target_directory
            ? [
                {
                  root_id: "legacy-destination",
                  role: "destination" as const,
                  path: config.target_directory,
                  display_name: null,
                  priority: 1,
                  exclusions: [],
                  identity: null,
                },
              ]
            : []),
        ];
  return profileRoots.map((root) => ({
    rootId: root.root_id,
    role: root.role,
    path: root.path,
    displayName: root.display_name,
    priority: root.priority,
    exclusions: root.exclusions,
    state: scanned ? "ready" : "unknown",
    volume: root.identity?.volume_id ?? null,
    freshness: scanned ? "fresh" : "unknown",
    indexedFiles: scanned && root.role === "input" ? indexedFiles : null,
    issueCount: 0,
  }));
}

export default function MainPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { theme, toggle: toggleTheme } = useTheme();
  const { config, isValid, updateConfig, saveError, retrySave } = useConfig();
  const { setLocale, locale, t } = useI18n();

  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [pendingConfigPatch, setPendingConfigPatch] = useState<Partial<Config> | null>(null);
  const [bodyKey, setBodyKey] = useState(0);
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  const [excludedForRun, setExcludedForRun] = useState<string[]>([]);
  const [stage, setStage] = useState<StageState["stage"]>("sources");
  const [pendingSettingAnchor, setPendingSettingAnchor] = useState<string | null>(null);

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

  useEffect(() => setImpactAcknowledged(false), [preview.result, config]);

  const scanned = analysis.result !== null && analysis.error === null;
  const planned = preview.result !== null && preview.error === null;
  const isSorting = sorting.status === "running" || sorting.status === "pending";
  const isAnyRunning = analysis.loading || preview.loading || isSorting;
  const recoveryOperations = useMemo(
    () => diagnostics?.recovery_operations ?? [],
    [diagnostics],
  );
  const recoveryBlock = startBlock(recoveryOperations);

  const cards = useMemo(
    () => rootCards(config, scanned, analysis.result?.total_files ?? 0),
    [analysis.result?.total_files, config, scanned],
  );

  // ── Configuration ──────────────────────────────────────────────────────────

  const handleConfigSave = useCallback(
    (patch: Partial<Config>) => {
      // Changing settings after a plan exists invalidates it, so the change is
      // confirmed rather than applied behind the user's back.
      if (analysis.result || preview.result) {
        setPendingConfigPatch(patch);
        return;
      }
      updateConfig(patch);
    },
    [analysis.result, preview.result, updateConfig],
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

  /** Ask the OS for a folder. Outside Tauri there is no picker to ask. */
  const pickFolder = useCallback(async (): Promise<string | null> => {
    if (!isTauri) {
      toast(t("sources.pickerUnavailable"), "warning");
      return null;
    }
    try {
      const { open } = await import("@tauri-apps/api/dialog");
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : null;
    } catch {
      toast(t("sources.folderPickerFailed"), "error");
      return null;
    }
  }, [t, toast]);

  const addFolder = useCallback(
    async (role: RootRole) => {
      const path = await pickFolder();
      if (!path) return;
      handleRootsChange([
        ...cards,
        {
          rootId: `${role}-${Date.now()}`,
          role,
          path,
          displayName: null,
          priority: cards.length,
          exclusions: [],
          state: "unknown",
          volume: null,
          freshness: "unknown",
          indexedFiles: null,
          issueCount: 0,
        },
      ]);
    },
    [cards, handleRootsChange, pickFolder],
  );

  const changeFolder = useCallback(
    async (rootId: string) => {
      const path = await pickFolder();
      if (!path) return;
      handleRootsChange(
        cards.map((card) => (card.rootId === rootId ? { ...card, path, volume: null } : card)),
      );
    },
    [cards, handleRootsChange, pickFolder],
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

  // ── The run ────────────────────────────────────────────────────────────────

  /**
   * Scan and plan in one act, then hand back whether there is a plan.
   *
   * Splitting these into two buttons made the user responsible for knowing that
   * a dry run needs a fresh index. It does; that is our problem, not theirs.
   */
  const buildPlan = useCallback(async (): Promise<boolean> => {
    if (recoveryBlock.blocked) {
      toast(recoveryBlock.reason ?? t("stage.recovery.blocked"), "warning");
      return false;
    }
    if (!isValid) {
      toast(t("analysis.requiredFolders"), "warning");
      return false;
    }
    if (!analysis.result) {
      preview.clear();
      await analysis.runAnalysis();
      // `runAnalysis` resolves once the task settles; a failure has already been
      // surfaced through `analysis.error`, and pressing on would plan on nothing.
      if (analysis.error) return false;
    }
    await preview.generatePreview();
    return preview.error === null;
  }, [analysis, isValid, preview, recoveryBlock, t, toast]);

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

  const startRun = useCallback(() => {
    void sorting.startSorting(
      false,
      preview.result?.config_fingerprint,
      preview.result?.plan_id,
    );
  }, [preview.result, sorting]);

  // ── Stage wiring ───────────────────────────────────────────────────────────

  const rootConflicts = useMemo(() => validateRoots(cards), [cards]);
  const rootBlocker = blockingConflicts(rootConflicts)[0];

  const stageInputs = {
    rootsReady: isValid && !rootBlocker,
    rootsReason: rootBlocker
      ? t(`sources.conflict.${rootBlocker.kind}`, rootBlocker.params, rootBlocker.message)
      : isValid
        ? null
        : t("stage.gate.roots"),
    scanned,
    planned,
    plannedReason: t("stage.gate.plan"),
    blocked: recoveryBlock.blocked,
    blockedReason: recoveryBlock.reason,
  };

  const stageKey = {
    profileId: config?.library_profile.profile_id ?? "",
    catalogGeneration: scanned ? 1 : 0,
    planVersion: planned ? 1 : 0,
    taskId: null,
  };

  const impact = preview.result?.impact;
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
    health?.status === "ok" ? "ready" : healthError ? "lost" : healthLoading ? "connecting" : "connecting";

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
        updateConfig({ language: next });
      }}
      historyCount={historyMeta?.total ?? 0}
      onOpenHistory={() => setHistoryOpen(true)}
      busy={isAnyRunning || loaderActive}
    />
  );

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
      {saveError && (
        <StateView
          variant="error"
          compact
          title={t("config.saveFailed")}
          detail={extractErrorMessage(saveError, t("config.saveFailedHelp"))}
          onRetry={retrySave}
        />
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
            <Suspense fallback={<StateView variant="loading" title={t("state.loading")} />}>
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
        titleBar={titleBar}
        banners={banners}
        onStateChange={(state) => setStage(state.stage)}
        footer={(state, nav) => {
          if (state.stage === "execute") return null;
          if (state.stage === "sources") {
            return (
              <ActionBar
                message={t("footer.sources")}
                primary={{
                  label: t("footer.toConfigure"),
                  onClick: () => nav.go("configure"),
                  disabled: !nav.canEnter("configure"),
                  disabledReason: nav.reasonFor("configure"),
                }}
              />
            );
          }
          if (state.stage === "configure") {
            const estimate = analysis.result
              ? t("footer.estimate", {
                  files: analysis.result.total_files.toLocaleString(locale),
                  duration: formatDuration(analysis.result.estimated_duration_seconds, {
                    style: "long",
                    locale,
                  }),
                  size: formatBytes(analysis.result.total_size_bytes, { locale }),
                })
              : t("footer.estimateUnknown");
            return (
              <ActionBar
                tone="estimate"
                message={estimate}
                back={{ label: t("common.back"), onClick: () => nav.go("sources") }}
                primary={{
                  label: t("footer.preview"),
                  busy: analysis.loading || preview.loading,
                  onClick: () => {
                    void buildPlan().then((ok) => ok && nav.go("review"));
                  },
                  disabled: !stageInputs.rootsReady || isAnyRunning,
                  disabledReason: stageInputs.rootsReason,
                }}
              />
            );
          }
          return (
            <ActionBar
              message={t("footer.review")}
              back={{ label: t("common.back"), onClick: () => nav.go("configure") }}
              primary={{
                label: t("footer.toExecute"),
                onClick: () => nav.go("execute"),
                disabled: !nav.canEnter("execute"),
                disabledReason: nav.reasonFor("execute"),
              }}
            />
          );
        }}
      >
        {(state, nav) => {
          if (state.stage === "sources") {
            return config ? (
              <SourcesScreen
                cards={cards}
                excludedForRun={excludedForRun}
                analysis={analysis.result}
                config={config}
                savedRecipes={savedRecipes}
                disabled={isAnyRunning}
                onChange={handleRootsChange}
                onExcludeForRun={setExcludedForRun}
                onAddFolder={(role) => void addFolder(role)}
                onChangeFolder={(rootId) => void changeFolder(rootId)}
                onRemove={removeFolder}
                onApplyConfig={handleConfigSave}
                onDeleteRecipe={(recipeId) => deleteRecipe.mutate(recipeId)}
              />
            ) : (
              <StateView variant="loading" title={t("state.loading")} />
            );
          }

          if (state.stage === "configure") {
            return (
              <ConfigureScreen
                disabled={isAnyRunning}
                bodyKey={bodyKey}
                onSaveConfig={handleConfigSave}
                onSaveRecipe={async (name, settings) => {
                  await saveRecipe.mutateAsync({ name, settings });
                }}
              />
            );
          }

          if (state.stage === "review") {
            if (preview.loading) {
              return (
                <PreviewProgressCard progress={preview.progress} elapsed={preview.elapsed} />
              );
            }
            if (preview.error) {
              return (
                <StateView
                  variant="error"
                  title={t("preview.failed")}
                  detail={preview.error}
                  onRetry={() => void preview.generatePreview()}
                />
              );
            }
            if (!preview.result || !config) {
              return (
                <StateView
                  variant="blocked"
                  title={t("stage.review.planNeeded")}
                  detail={t("stage.gate.plan")}
                  action={
                    <Button size="sm" onClick={() => void buildPlan()}>
                      {t("preview.action")}
                    </Button>
                  }
                />
              );
            }
            return (
              <ReviewScreen
                result={preview.result}
                config={config}
                view={state.view as View}
                onSelectView={nav.selectView}
                onOpenSetting={(anchorId) => openSetting(anchorId, nav)}
                onRerunPreview={() => void preview.generatePreview()}
              />
            );
          }

          // Execute.
          if (!config) return <StateView variant="loading" title={t("state.loading")} />;
          if (sorting.report) {
            return (
              <Suspense fallback={<StateView variant="loading" title={t("state.loading")} />}>
                <FinishedRun report={sorting.report} />
              </Suspense>
            );
          }
          if (sorting.status === "idle") {
            return (
              <ExecutePreflight
                input={preflightInput}
                onAcknowledge={setImpactAcknowledged}
                onExecute={startRun}
                busy={isSorting}
              />
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
              onCancel={() => setCancelConfirmOpen(true)}
              onRetry={startRun}
            >
              <RunLog entries={logs} running={isSorting} />
            </ExecuteScreen>
          );
        }}
      </StageShell>

      <ConfirmDialog
        open={pendingConfigPatch !== null}
        title={t("dialog.applyReset.title")}
        description={t("dialog.applyReset.description")}
        confirmLabel={t("dialog.applyReset.confirm")}
        cancelLabel={t("common.cancel")}
        onClose={() => {
          setPendingConfigPatch(null);
          setBodyKey((key) => key + 1);
        }}
        onConfirm={() => {
          if (pendingConfigPatch) updateConfig(pendingConfigPatch);
          setPendingConfigPatch(null);
          analysis.clear();
          preview.clear();
        }}
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

/** The run is over: the celebration, then the report it produced. */
function FinishedRun({ report }: { report: OperationReport }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <div className="animate-fade-in rounded-2xl border border-success/40 bg-tint-success px-5 py-4">
        <p className="text-sm font-bold text-foreground">
          {t(
            report.summary.sorted === 1
              ? report.duration_seconds
                ? "report.organizedIn.one"
                : "report.organized.one"
              : report.duration_seconds
                ? "report.organizedIn"
                : "report.organized",
            {
              count: report.summary.sorted.toLocaleString(locale),
              duration: formatDuration(report.duration_seconds, { style: "long", locale }),
            },
          )}
        </p>
      </div>
      <ReportPanel report={report} />
    </div>
  );
}
