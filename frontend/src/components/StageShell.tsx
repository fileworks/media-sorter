/**
 * Sources → Configure → Review → Execute, inside one window frame.
 *
 * The shell owns exactly one thing: which stage and view are current, and
 * whether the next one may be entered. Everything it renders around the content
 * — the title row, the stepper, the footer rail — is a slot, so a screen can
 * put its own primary action in the footer without the shell knowing what that
 * action does.
 *
 * Going backwards is allowed and is never silent — the transition says what it
 * invalidated before the user is somewhere else and has forgotten asking.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiAlertTriangle } from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StageStepper } from "@/components/shell/StageStepper";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";
import {
  INITIAL_STATE,
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

/** What a screen may do to navigation without owning it. */
export interface StageNav {
  go: (stage: Stage, view?: View) => void;
  selectView: (view: View) => void;
  canEnter: (stage: Stage) => boolean;
  reasonFor: (stage: Stage) => string | null;
}

interface StageShellProps {
  inputs: StageInputs;
  stageKey: StageKey;
  /** The title row. Rendered above the stepper, on every stage. */
  titleBar: ReactNode;
  /** App-wide banners (recovery, update, backend loss) above the screen body. */
  banners?: ReactNode;
  /** Rendered for the current stage and view. */
  children: (state: StageState, nav: StageNav) => ReactNode;
  /** The footer rail. Returning null hides it — Execute carries its own controls. */
  footer?: (state: StageState, nav: StageNav) => ReactNode;
  onStateChange?: (state: StageState) => void;
}

const INVALIDATION_KEYS: Record<string, string> = {
  "Changing folders makes the current review stale.": "stage.invalidated.folders",
  "Changing settings makes the current review stale.": "stage.invalidated.settings",
  "The frozen plan for this run is discarded; a new one will be taken.": "stage.invalidated.plan",
  "A different library profile is active.": "stage.invalidated.profile",
  "The folders were scanned again since you were last here.": "stage.invalidated.scan",
  "The review plan changed.": "stage.invalidated.review",
};

export function StageShell({
  inputs,
  stageKey,
  titleBar,
  banners,
  children,
  footer,
  onStateChange,
}: StageShellProps) {
  const { t } = useI18n();
  const [state, setState] = useState<StageState>({ ...INITIAL_STATE, key: stageKey });
  const [invalidated, setInvalidated] = useState<string[]>([]);
  const [pending, setPending] = useState<{ stage: Stage; view?: View } | null>(null);

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

  // Kept in a ref so an inline callback from the caller does not make "the state
  // changed" fire on every render of the caller.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => onStateChangeRef.current?.(state), [state]);

  const commitMove = useCallback(
    (stage: Stage, view?: View) => {
      if (!readiness(stage, inputs).canEnter) return;
      setState((current) => {
        const transition = goTo(current, stage, view);
        setInvalidated(transition.invalidated);
        return transition.state;
      });
      setPending(null);
    },
    [inputs],
  );

  const requestMove = useCallback(
    (stage: Stage, view?: View) => {
      if (!readiness(stage, inputs).canEnter) return;
      if (goTo(state, stage, view).invalidated.length > 0) {
        setPending({ stage, view });
        return;
      }
      commitMove(stage, view);
    },
    [commitMove, inputs, state],
  );

  const nav = useMemo<StageNav>(
    () => ({
      go: requestMove,
      selectView: (view) => setState((current) => selectView(current, view)),
      canEnter: (stage) => readiness(stage, inputs).canEnter,
      reasonFor: (stage) => readiness(stage, inputs).reason,
    }),
    [inputs, requestMove],
  );

  const pendingInvalidation = pending ? goTo(state, pending.stage, pending.view).invalidated : [];
  const invalidationText = (line: string) => {
    const key = INVALIDATION_KEYS[line];
    return key ? t(key, undefined, line) : line;
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {titleBar}

      <StageStepper
        current={state.stage}
        gate={(stage) => readiness(stage, inputs)}
        onSelect={(stage) => requestMove(stage)}
      />

      {/* `relative` is not decoration. `sr-only` is `position: absolute`, so
          without a positioned ancestor every visually-hidden label and radio in
          the screen below resolves against the viewport, escapes this scroll
          container, and makes the *document* taller than the window — at which
          point a `scrollIntoView` scrolls the title bar and stepper off the top
          of the app. Anchoring them here keeps `<main>` the only scroller. */}
      <main
        className="relative min-h-0 flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable" }}
        aria-labelledby="current-stage-heading"
      >
        <div className="mx-auto w-full max-w-[80rem] px-4 py-5 sm:px-6">
          {(banners || invalidated.length > 0) && (
            <div className="mb-4 space-y-3">
              {banners}
              {invalidated.length > 0 && (
                <div
                  className="flex items-start gap-3 rounded-xl border border-warning/40 bg-tint-warning p-3 text-xs"
                  role="status"
                >
                  <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <ul className="min-w-0 flex-1 space-y-1 text-foreground">
                    {invalidated.map((line) => (
                      <li key={line}>{invalidationText(line)}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => setInvalidated([])}
                    className={cn(
                      "shrink-0 rounded-lg px-2 py-1 font-medium text-warning",
                      "hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    {t("common.dismiss", undefined, "Got it")}
                  </button>
                </div>
              )}
            </div>
          )}

          {children(state, nav)}
        </div>
      </main>

      {footer?.(state, nav)}

      <ConfirmDialog
        open={pending !== null}
        title={t("stage.back.title")}
        description={t("stage.back.description")}
        confirmLabel={t("stage.back.confirm")}
        cancelLabel={t("common.cancel")}
        onClose={() => setPending(null)}
        onConfirm={() => pending && commitMove(pending.stage, pending.view)}
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
