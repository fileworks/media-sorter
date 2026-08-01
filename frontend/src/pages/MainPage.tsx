import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiArrowLeft, FiCheckCircle, FiClock, FiMoon, FiSun, FiX } from "react-icons/fi";

import { AnalysisPanel } from "@/components/AnalysisPanel";
import { ConfigPanel } from "@/components/ConfigPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ExecutePreflight } from "@/components/OperationCenter";
import { LogViewer } from "@/components/LogViewer";
import { PreviewProgressCard } from "@/components/PreviewProgressCard";
import { RecoveryBanner } from "@/components/RecoveryBanner";
import { SourcesPanel } from "@/components/SourcesPanel";
import { StageShell } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/toast-context";
import { useAnalysis } from "@/hooks/useAnalysis";
import { useConfig } from "@/hooks/useConfig";
import { useGlobalLoader } from "@/hooks/useGlobalLoader";
import { usePreview } from "@/hooks/usePreview";
import { useSorting } from "@/hooks/useSorting";
import { useTheme } from "@/hooks/useTheme";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useI18n } from "@/i18n/I18nContext";
import type { RootCard } from "@/lib/sourcesStage";
import type { StageState } from "@/lib/stageModel";
import { startBlock } from "@/lib/startupRecovery";
import { cn, isTauri } from "@/lib/utils";
import { formatDuration } from "@/lib/formatters";
import { extractErrorMessage } from "@/lib/errorUtils";
import { api } from "@/services/api";
import type { Config, OperationReport } from "@/types/api";

const HistoryPanel = lazy(() =>
  import("@/components/HistoryPanel").then((module) => ({ default: module.HistoryPanel })),
);
const PreviewPanel = lazy(() =>
  import("@/components/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const ReviewWorkbench = lazy(() =>
  import("@/components/ReviewWorkbench").then((module) => ({ default: module.ReviewWorkbench })),
);
const CatalogPanel = lazy(() =>
  import("@/components/CatalogPanel").then((module) => ({ default: module.CatalogPanel })),
);
const QuarantineManager = lazy(() =>
  import("@/components/QuarantineManager").then((module) => ({
    default: module.QuarantineManager,
  })),
);
const ValidationPanel = lazy(() =>
  import("@/components/ValidationPanel").then((module) => ({ default: module.ValidationPanel })),
);
const LibraryAuditPanel = lazy(() =>
  import("@/components/LibraryAuditPanel").then((module) => ({
    default: module.LibraryAuditPanel,
  })),
);
const BurstReviewPanel = lazy(() =>
  import("@/components/BurstReviewPanel").then((module) => ({
    default: module.BurstReviewPanel,
  })),
);
const DestinationReconciliationPanel = lazy(() =>
  import("@/components/DestinationReconciliationPanel").then((module) => ({
    default: module.DestinationReconciliationPanel,
  })),
);
const SortingProgress = lazy(() =>
  import("@/components/SortingProgress").then((module) => ({
    default: module.SortingProgress,
  })),
);
const ReportPanel = lazy(() =>
  import("@/components/ReportPanel").then((module) => ({ default: module.ReportPanel })),
);

const WELCOME_KEY = "mediasort_welcome_seen";

function FirstRunWelcome({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div className="animate-fade-in rounded-xl border border-primary/20 bg-primary/10 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <FiCheckCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{t("app.welcome")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("app.welcomeHelp")}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground/60 hover:text-muted-foreground"
          aria-label={t("accessibility.dismiss")}
        >
          <FiX className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SortCelebration({ report }: { report: OperationReport }) {
  const { t, locale } = useI18n();
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div className="animate-fade-in rounded-xl border border-primary/30 bg-primary/10 px-5 py-4">
      <div className="flex items-center gap-4">
        <FiCheckCircle className="h-6 w-6 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm font-bold text-foreground">
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
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label={t("accessibility.dismiss")}
          className="rounded p-1 text-primary/50 hover:text-primary"
        >
          <FiX className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function TopProgressBar({ busy }: { busy: boolean }) {
  return busy ? (
    <div className="progress-indeterminate absolute inset-x-0 top-0 h-0.5" aria-hidden />
  ) : null;
}

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
  const { theme, toggle: toggleTheme } = useTheme();
  const { config, isValid, updateConfig, saveError, retrySave } = useConfig();
  const { setLocale, t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [pendingConfigPatch, setPendingConfigPatch] = useState<Partial<Config> | null>(null);
  const [sectionBodyKey, setSectionBodyKey] = useState(0);
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_KEY);
    } catch {
      return false;
    }
  });

  const analysis = useAnalysis();
  const preview = usePreview();
  const sorting = useSorting();
  const loaderActive = useGlobalLoader();
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
  const reviewed = preview.result !== null && preview.error === null;
  const isSorting = sorting.status === "running" || sorting.status === "pending";
  const isAnyRunning = analysis.loading || preview.loading || isSorting;
  const recoveryOperations = diagnostics?.recovery_operations ?? [];
  const recoveryBlock = startBlock(recoveryOperations);
  const cards = useMemo(
    () => rootCards(config, scanned, analysis.result?.total_files ?? 0),
    [analysis.result?.total_files, config, scanned],
  );

  const handleConfigSave = useCallback(
    (patch: Partial<Config>) => {
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
      const source = roots.find((root) => root.role === "input")?.path ?? "";
      const destination = roots.find((root) => root.role === "destination")?.path ?? "";
      handleConfigSave({
        source_directory: source,
        target_directory: destination,
        library_profile: { ...config.library_profile, roots },
      });
    },
    [config, handleConfigSave],
  );

  const pickRootFolder = useCallback(async () => {
    if (!isTauri) {
      document
        .getElementById("source-dir")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => document.getElementById("source-dir")?.focus(), 350);
      return;
    }
    try {
      const { open } = await import("@tauri-apps/api/dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      handleRootsChange([
        ...cards,
        {
          rootId: `input-${Date.now()}`,
          role: "input",
          path: selected,
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
    } catch {
      toast(t("sources.folderPickerFailed"), "error");
    }
  }, [cards, handleRootsChange, t, toast]);

  const dismissWelcome = useCallback(() => {
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      // Local storage is optional.
    }
    setWelcomeVisible(false);
  }, []);

  const runAnalysis = async () => {
    if (recoveryBlock.blocked) {
      toast(recoveryBlock.reason ?? t("stage.recovery.blocked"), "warning");
      return;
    }
    if (!isValid) {
      toast(t("analysis.requiredFolders"), "warning");
      return;
    }
    preview.clear();
    await analysis.runAnalysis();
  };

  const runPreview = async () => {
    if (!analysis.result) {
      toast(t("analysis.runFirst"), "warning");
      return;
    }
    await preview.generatePreview();
  };

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

  const stageInputs = {
    rootsReady: isValid,
    rootsReason: isValid ? null : t("stage.gate.roots"),
    scanned,
    reviewed,
    reviewedReason: t("stage.gate.review"),
    blocked: recoveryBlock.blocked,
    blockedReason: recoveryBlock.reason,
  };
  const stageKey = {
    profileId: config?.library_profile.profile_id ?? "",
    catalogGeneration: scanned ? 1 : 0,
    planVersion: reviewed ? 1 : 0,
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

  const renderSources = () => (
    <div className="space-y-4">
      {welcomeVisible && !config?.source_directory && (
        <FirstRunWelcome onDismiss={dismissWelcome} />
      )}
      <SourcesPanel
        cards={cards}
        onChange={handleRootsChange}
        onPickFolder={() => void pickRootFolder()}
        config={config}
        onApplyConfig={handleConfigSave}
      />
      <ConfigPanel
        disabled={isAnyRunning}
        onSaveConfig={handleConfigSave}
        sectionBodyKey={sectionBodyKey}
      />
      {cards.length === 0 ? null : analysis.loading ? (
        <StateView variant="loading" title={t("analysis.scanning")} />
      ) : analysis.error ? (
        <StateView
          variant="error"
          title={t("analysis.failed")}
          detail={analysis.error}
          onRetry={() => void runAnalysis()}
        />
      ) : analysis.result ? (
        <AnalysisPanel
          result={analysis.result}
          loading={false}
          error={null}
          onRetry={() => void runAnalysis()}
          onBackToConfig={() => undefined}
        />
      ) : (
        <StateView
          variant={isValid ? "empty" : "blocked"}
          title={isValid ? t("stage.sources.ready") : t("stage.sources.blocked")}
          detail={isValid ? t("stage.sources.scanHelp") : t("stage.gate.roots")}
          action={
            <Button
              size="sm"
              disabled={!isValid || !health || recoveryBlock.blocked}
              onClick={() => void runAnalysis()}
            >
              {t("analysis.action")}
            </Button>
          }
        />
      )}
    </div>
  );

  const renderReview = (state: StageState) => {
    if (!scanned) {
      return (
        <StateView
          variant="blocked"
          title={t("stage.review.notScanned")}
          detail={t("stage.gate.scan")}
        />
      );
    }
    if (state.view === "overview") {
      return (
        <div className="space-y-4">
          <AnalysisPanel
            result={analysis.result}
            loading={false}
            error={analysis.error}
            onRetry={() => void runAnalysis()}
            onBackToConfig={() => undefined}
          />
          {preview.loading ? (
            <PreviewProgressCard progress={preview.progress} elapsed={preview.elapsed} />
          ) : (
            <StateView
              variant={preview.error ? "error" : preview.result ? "empty" : "blocked"}
              title={
                preview.error
                  ? t("preview.failed")
                  : preview.result
                    ? t("stage.review.planReady")
                    : t("stage.review.planNeeded")
              }
              detail={preview.error ?? t("stage.review.planHelp")}
              onRetry={preview.error ? () => void runPreview() : undefined}
              action={
                !preview.error ? (
                  <Button size="sm" onClick={() => void runPreview()}>
                    {preview.result ? t("preview.rerun") : t("preview.action")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      );
    }
    if (state.view === "organization") {
      return preview.loading ? (
        <PreviewProgressCard progress={preview.progress} elapsed={preview.elapsed} />
      ) : (
        <PreviewPanel
          result={preview.result}
          loading={false}
          error={preview.error}
          onRetry={() => void runPreview()}
          copyInsteadOfMove={config?.copy_instead_of_move}
          categorizeEnabled={config?.categorize_enabled}
          sortCriteria={config?.sort_criteria ?? ["year", "month", "day"]}
        />
      );
    }
    if (state.view === "exact") {
      return <ReviewWorkbench kindFilter="exact" items={preview.result?.items ?? []} />;
    }
    if (state.view === "similar") {
      return <ReviewWorkbench kindFilter="similar" items={preview.result?.items ?? []} />;
    }
    if (state.view === "bursts") {
      const inputRoot = config?.library_profile.roots.find((root) => root.role === "input");
      return inputRoot ? (
        <BurstReviewPanel
          root={inputRoot.path}
          items={preview.result?.items ?? []}
          enabled={config?.burst_detection_enabled ?? false}
        />
      ) : (
        <StateView variant="blocked" title={t("stage.gate.roots")} />
      );
    }
    if (state.view === "reconciliation") {
      return <DestinationReconciliationPanel items={preview.result?.items ?? []} />;
    }
    if (state.view === "validation") {
      const inputRoot = config?.library_profile.roots.find((root) => root.role === "input");
      const destinationRoot = config?.library_profile.roots.find(
        (root) => root.role === "destination",
      );
      return inputRoot ? (
        <div className="space-y-6">
          <ValidationPanel rootId={inputRoot.root_id} />
          {destinationRoot?.path && <LibraryAuditPanel root={destinationRoot.path} />}
        </div>
      ) : (
        <StateView variant="blocked" title={t("stage.gate.roots")} />
      );
    }
    return (
      <div className="space-y-6">
        <CatalogPanel />
        <QuarantineManager />
      </div>
    );
  };

  const renderExecute = () => {
    if (!reviewed) {
      return (
        <StateView
          variant="blocked"
          title={t("stage.execute.notReady")}
          detail={t("stage.gate.review")}
        />
      );
    }
    if (sorting.report) {
      return (
        <div className="space-y-4">
          <SortCelebration report={sorting.report} />
          <ReportPanel report={sorting.report} />
        </div>
      );
    }
    if (sorting.status !== "idle") {
      return (
        <SortingProgress
          progress={sorting.progress ?? null}
          status={sorting.status}
          error={sorting.error}
          onCancel={() => setCancelConfirmOpen(true)}
          onViewReport={() => undefined}
          onRetry={() =>
            void sorting.startSorting(
              false,
              preview.result?.config_fingerprint,
              preview.result?.plan_id,
            )
          }
        />
      );
    }
    return (
      <ExecutePreflight
        input={preflightInput}
        onAcknowledge={setImpactAcknowledged}
        onExecute={() =>
          void sorting.startSorting(
            false,
            preview.result?.config_fingerprint,
            preview.result?.plan_id,
          )
        }
        busy={isSorting}
      />
    );
  };

  const backendColor =
    health?.status === "ok"
      ? "bg-success"
      : healthLoading
        ? "bg-warning animate-pulse"
        : "bg-error";
  const globalBusy = isAnyRunning || loaderActive;

  if (historyOpen) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header className="relative shrink-0 border-b border-border/80 bg-card/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
          <TopProgressBar busy={globalBusy} />
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHistoryOpen(false)}
              className="text-muted-foreground"
            >
              <FiArrowLeft className="h-4 w-4" aria-hidden />
              {t("app.back")}
            </Button>
            <span className="truncate text-sm font-semibold text-foreground">
              {t("app.sortHistory")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              title={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
              aria-label={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
            >
              {theme === "dark" ? (
                <FiSun className="h-4 w-4" aria-hidden />
              ) : (
                <FiMoon className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-5">
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
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="relative shrink-0 border-b border-border/80 bg-card/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
        <TopProgressBar busy={globalBusy} />
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/icon.svg"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 shrink-0 rounded-xl shadow-sm"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-base font-bold tracking-tight text-foreground">
                  MediaSorter
                </span>
                {health?.version && (
                  <span className="hidden rounded-full bg-primary/10 px-2 py-0.5 text-3xs font-semibold text-primary sm:inline">
                    v{health.version}
                  </span>
                )}
              </div>
              <p className="hidden truncate text-2xs text-muted-foreground sm:block">
                {t("app.tagline")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <div
              className="hidden items-center gap-2 rounded-full border border-border/80 bg-background px-2.5 py-1.5 text-2xs text-muted-foreground md:flex"
              role="status"
              title={
                health?.status === "ok"
                  ? t("backend.connected", { version: health.version })
                  : t("backend.connecting")
              }
            >
              <span className={cn("h-2 w-2 rounded-full", backendColor)} />
              {health?.status === "ok" ? t("backend.ready") : t("backend.connecting")}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              title={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
              aria-label={t(theme === "dark" ? "app.switchLight" : "app.switchDark")}
            >
              {theme === "dark" ? (
                <FiSun className="h-4 w-4" aria-hidden />
              ) : (
                <FiMoon className="h-4 w-4" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              className="px-2 text-muted-foreground sm:px-3"
              title={t("app.history")}
            >
              <FiClock className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{t("app.history")}</span>
              {(historyMeta?.total ?? 0) > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-3xs font-semibold">
                  {historyMeta?.total}
                </span>
              )}
            </Button>
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg md:hidden"
              role="status"
              aria-label={
                health?.status === "ok"
                  ? t("backend.connected", { version: health.version })
                  : t("backend.connecting")
              }
            >
              <span className={cn("h-2.5 w-2.5 rounded-full", backendColor)} />
            </div>
          </div>
        </div>
      </header>

      <main
        className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:py-7"
        style={{ scrollbarGutter: "stable" }}
      >
        <div className="mx-auto max-w-7xl space-y-4">
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

          <StageShell inputs={stageInputs} stageKey={stageKey}>
            {(state) => {
              const content =
                state.stage === "sources"
                  ? renderSources()
                  : state.stage === "review"
                    ? renderReview(state)
                    : renderExecute();
              return (
                <Suspense fallback={<StateView variant="loading" title={t("state.loading")} />}>
                  {content}
                </Suspense>
              );
            }}
          </StageShell>
        </div>
      </main>

      {cancellableOperation && (
        <footer className="shrink-0 border-t border-border bg-background px-6 py-2">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{t("state.working")}</span>
            <button
              type="button"
              onClick={() => setCancelConfirmOpen(true)}
              className="rounded-lg border border-border px-3 py-1 text-warning"
            >
              {t("operation.cancel")}
            </button>
          </div>
        </footer>
      )}

      <LogViewer isRunning={isAnyRunning} />

      <ConfirmDialog
        open={pendingConfigPatch !== null}
        title={t("dialog.applyReset.title")}
        description={t("dialog.applyReset.description")}
        confirmLabel={t("dialog.applyReset.confirm")}
        cancelLabel={t("common.cancel")}
        onClose={() => {
          setPendingConfigPatch(null);
          setSectionBodyKey((key) => key + 1);
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
    </div>
  );
}
