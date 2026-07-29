/**
 * Sources → Review → Execute, with the operation center alongside all three.
 *
 * The shell owns exactly one thing: which stage and view are current, and
 * whether the next one may be entered. Every panel underneath stays unaware of
 * navigation, which is what lets the old `MainPage` keep working while this is
 * behind a flag.
 *
 * Going backwards is allowed and is never silent — the transition says what it
 * invalidated before the user is somewhere else and has forgotten asking.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  FiAlertTriangle,
  FiCamera,
  FiCheck,
  FiCopy,
  FiFolder,
  FiGrid,
  FiHome,
  FiImage,
  FiPlay,
  FiRefreshCw,
  FiSearch,
  FiShield,
} from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { OperationCenter } from "@/components/OperationCenter";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";
import type { OperationSummary } from "@/lib/operationCenter";
import {
  INITIAL_STATE,
  STAGE_LABELS,
  VIEWS_BY_STAGE,
  goTo,
  readiness,
  reconcile,
  selectView,
  type Stage,
  type StageInputs,
  type StageKey,
  type StageState,
  type View,
} from "@/lib/stageModel";

interface StageShellProps {
  inputs: StageInputs;
  stageKey: StageKey;
  operations?: OperationSummary[];
  /** Rendered for the current stage and view. */
  children: (state: StageState) => ReactNode;
  onStateChange?: (state: StageState) => void;
}

const STAGE_ICONS: Record<Stage, IconType> = {
  sources: FiFolder,
  review: FiSearch,
  execute: FiPlay,
};

const VIEW_ICONS: Record<View, IconType> = {
  overview: FiHome,
  organization: FiGrid,
  exact: FiCopy,
  similar: FiImage,
  bursts: FiCamera,
  reconciliation: FiRefreshCw,
  validation: FiShield,
  issues: FiAlertTriangle,
};

const INVALIDATION_KEYS: Record<string, string> = {
  "Changing folders makes the current review stale.": "stage.invalidated.folders",
  "The frozen plan for this run is discarded; a new one will be taken.":
    "stage.invalidated.plan",
  "A different library profile is active.": "stage.invalidated.profile",
  "The folders were scanned again since you were last here.": "stage.invalidated.scan",
  "The review plan changed.": "stage.invalidated.review",
};

export function StageShell({
  inputs,
  stageKey,
  operations = [],
  children,
  onStateChange,
}: StageShellProps) {
  const { t } = useI18n();
  const [state, setState] = useState<StageState>({ ...INITIAL_STATE, key: stageKey });
  const [invalidated, setInvalidated] = useState<string[]>([]);
  const [pendingStage, setPendingStage] = useState<Stage | null>(null);

  // The world can move while the user is standing in a stage — a rescan, a new
  // plan version, a different profile. Reconciling puts them somewhere valid and
  // says why, rather than rendering a view built on facts that are gone.
  useEffect(() => {
    setState((current) => {
      const transition = reconcile(current, stageKey);
      if (transition.invalidated.length > 0) {
        setInvalidated(transition.invalidated);
      }
      return transition.state;
    });
  }, [stageKey]);

  useEffect(() => onStateChange?.(state), [state, onStateChange]);

  const commitMove = useCallback(
    (stage: Stage) => {
      const gate = readiness(stage, inputs);
      if (!gate.canEnter) return;
      const transition = goTo(state, stage);
      setInvalidated(transition.invalidated);
      setState(transition.state);
      setPendingStage(null);
    },
    [inputs, state],
  );

  const requestMove = useCallback(
    (stage: Stage) => {
      const gate = readiness(stage, inputs);
      if (!gate.canEnter) return;
      const transition = goTo(state, stage);
      if (transition.invalidated.length > 0) {
        setPendingStage(stage);
        return;
      }
      commitMove(stage);
    },
    [commitMove, inputs, state],
  );

  const views = VIEWS_BY_STAGE[state.stage];
  const pendingInvalidation = pendingStage ? goTo(state, pendingStage).invalidated : [];
  const currentStageIndex = STAGE_LABELS.findIndex((entry) => entry.stage === state.stage);
  const currentTitle =
    state.stage === "review" ? t(`view.${state.view}`) : t(`stage.${state.stage}.label`);
  const currentDescription =
    state.stage === "review"
      ? t("stage.review.description")
      : t(`stage.${state.stage}.description`);
  const invalidationText = (line: string) => {
    const key = INVALIDATION_KEYS[line];
    return key ? t(key, undefined, line) : line;
  };

  return (
    <div
      className="grid items-start gap-5 lg:grid-cols-[15.5rem_minmax(0,1fr)]"
      aria-labelledby="current-stage-heading"
    >
      <aside className="min-w-0 space-y-3 lg:sticky lg:top-5">
        <nav
          aria-label={t("stage.navigation")}
          className="rounded-2xl border border-border/80 bg-card p-2 shadow-sm"
        >
          <ol className="grid grid-cols-3 gap-1 lg:grid-cols-1">
            {STAGE_LABELS.map((entry, index) => {
              const gate = readiness(entry.stage, inputs);
              const current = state.stage === entry.stage;
              const complete = index < currentStageIndex;
              const Icon = STAGE_ICONS[entry.stage];
              return (
                <li key={entry.stage}>
                  <button
                    type="button"
                    disabled={!gate.canEnter && !current}
                    aria-current={current ? "step" : undefined}
                    title={gate.reason ?? t(`stage.${entry.stage}.description`)}
                    aria-describedby={
                      !gate.canEnter && !current ? `stage-gate-${entry.stage}` : undefined
                    }
                    onClick={() => requestMove(entry.stage)}
                    className={cn(
                      "group flex min-h-[4.25rem] min-w-0 w-full flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors",
                      "lg:flex-row lg:justify-start lg:gap-3 lg:px-3 lg:text-left",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      current
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      !gate.canEnter && !current && "cursor-not-allowed opacity-45",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                        current
                          ? "border-primary-foreground/20 bg-primary-foreground/10"
                          : "border-border bg-background text-foreground",
                      )}
                    >
                      {complete ? (
                        <FiCheck className="h-4 w-4" aria-hidden />
                      ) : (
                        <Icon className="h-4 w-4" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 max-w-full">
                      <span className="block truncate text-xs font-semibold sm:text-sm">
                        {t(`stage.${entry.stage}.label`)}
                      </span>
                      <span
                        id={`stage-gate-${entry.stage}`}
                        className={cn(
                          "mt-0.5 hidden text-[11px] leading-snug lg:block",
                          current ? "text-primary-foreground/75" : "text-muted-foreground",
                        )}
                      >
                        {gate.canEnter || current
                          ? t(`stage.${entry.stage}.description`)
                          : gate.reason}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <OperationCenter operations={operations} />
      </aside>

      <section className="min-w-0 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              {t(`stage.${state.stage}.label`)}
            </p>
            <h1
              id="current-stage-heading"
              className="mt-1 text-xl font-semibold tracking-tight text-foreground"
              aria-live="polite"
            >
              {currentTitle}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{currentDescription}</p>
          </div>
        </header>

        {views.length > 1 && (
          <nav aria-label={t("view.navigation")} className="-mx-1 overflow-x-auto px-1 pb-1">
            <ul className="flex min-w-max gap-1 rounded-xl border border-border/80 bg-card p-1 shadow-sm">
              {views.map((view) => {
                const Icon = VIEW_ICONS[view];
                const current = state.view === view;
                return (
                  <li key={view}>
                    <button
                      type="button"
                      aria-pressed={current}
                      onClick={() => setState((value) => selectView(value, view))}
                      className={cn(
                        "flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        current
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {t(`view.${view}`)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {invalidated.length > 0 && (
          <div
            className="flex items-start gap-3 rounded-xl border border-warning/35 bg-warning/10 p-3 text-xs"
            role="status"
          >
            <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <ul className="space-y-1 text-foreground">
                {invalidated.map((line) => (
                  <li key={line}>{invalidationText(line)}</li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setInvalidated([])}
              className="shrink-0 rounded-lg px-2 py-1 font-medium text-warning hover:bg-warning/10"
            >
              {t("common.dismiss", undefined, "Got it")}
            </button>
          </div>
        )}

        <div className="min-w-0">{children(state)}</div>
      </section>

      <ConfirmDialog
        open={pendingStage !== null}
        title={t("stage.back.title")}
        description={t("stage.back.description")}
        confirmLabel={t("stage.back.confirm")}
        cancelLabel={t("common.cancel")}
        onClose={() => setPendingStage(null)}
        onConfirm={() => pendingStage && commitMove(pendingStage)}
      >
        <ul className="space-y-1 text-xs text-muted-foreground">
          {pendingInvalidation.map((line) => (
            <li key={line}>{invalidationText(line)}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
