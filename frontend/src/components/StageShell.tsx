/**
 * Sources → Setup → Review → Execute, inside one window frame.
 *
 * The shell owns exactly one thing: which stage and view are current, and
 * whether the next one may be entered. Everything it renders around the content
 * — the title row, the stepper, the footer rail — is a slot, so a screen can
 * put its own primary action in the footer without the shell knowing what that
 * action does.
 *
 * Going backwards is allowed, and once a plan exists it is also free: the stages
 * behind the plan render read-only, so returning to one costs nothing and needs
 * no permission. What used to be a dialog per settings change is now one lock
 * with one way out, asked at the moment the intent to edit appears rather than
 * once per keystroke.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiAlertTriangle, FiEdit2, FiLock } from "react-icons/fi";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { StageStepper } from "@/components/shell/StageStepper";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";
import {
  INITIAL_STATE,
  goTo,
  isStageLocked,
  readiness,
  reconcile,
  selectView,
  stageDrawsOwnLock,
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
  /**
   * A plan has been calculated, so the stages that fed it become readable
   * rather than editable until it is deliberately discarded.
   */
  planExists?: boolean;
  /** Whether each stage still has a valid completed artifact. */
  complete?: (stage: Stage) => boolean;
  /** An explicit lifecycle action such as “start a new run” may request a stage. */
  requestedStage?: Stage | null;
  onReviewViewChange?: (view: "plan" | "review") => void;
  /** Discard the plan, which is the one way out of the lock. */
  onUnlock?: () => void;
  /** Rendered for the current stage and view. `locked` is read-only-ness. */
  children: (state: StageState, nav: StageNav, locked: boolean) => ReactNode;
  /** The footer rail. Returning null hides it — Execute carries its own controls. */
  footer?: (state: StageState, nav: StageNav) => ReactNode;
  onStateChange?: (state: StageState) => void;
}

const INVALIDATION_KEYS: Record<string, string> = {
  "Changing folders makes the current review stale.": "stage.invalidated.folders",
  "Changing settings makes the current review stale.": "stage.invalidated.settings",
  "A different library profile is active.": "stage.invalidated.profile",
  "The folders were scanned again since you were last here.": "stage.invalidated.scan",
  "The review plan changed.": "stage.invalidated.review",
};

export function StageShell({
  inputs,
  stageKey,
  titleBar,
  banners,
  planExists = false,
  complete = () => false,
  requestedStage = null,
  onReviewViewChange,
  onUnlock,
  children,
  footer,
  onStateChange,
}: StageShellProps) {
  const { t } = useI18n();
  const [state, setState] = useState<StageState>({ ...INITIAL_STATE, key: stageKey });
  const [invalidated, setInvalidated] = useState<string[]>([]);
  const [pending, setPending] = useState<{ stage: Stage; view?: View } | null>(null);
  const [unlockAsked, setUnlockAsked] = useState(false);

  const locked = isStageLocked(state.stage, planExists);

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
        // `goTo` states what *editing* that stage would cost. Arriving at a
        // locked stage edits nothing, so warning about a loss that cannot
        // happen while standing there is the dialog people learn to dismiss.
        setInvalidated(isStageLocked(stage, planExists) ? [] : transition.invalidated);
        return transition.state;
      });
      setPending(null);
    },
    [inputs, planExists],
  );

  const requestMove = useCallback(
    (stage: Stage, view?: View) => {
      if (!readiness(stage, inputs).canEnter) return;
      if (!isStageLocked(stage, planExists) && goTo(state, stage, view).invalidated.length > 0) {
        setPending({ stage, view });
        return;
      }
      commitMove(stage, view);
    },
    [commitMove, inputs, planExists, state],
  );

  useEffect(() => {
    if (requestedStage) commitMove(requestedStage);
  }, [commitMove, requestedStage]);

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
        complete={complete}
        onSelect={(stage, nextReviewView) => {
          if (nextReviewView) onReviewViewChange?.(nextReviewView);
          requestMove(stage);
        }}
      />

      {/* `relative` is not decoration. `sr-only` is `position: absolute`, so
          without a positioned ancestor every visually-hidden label and radio in
          the screen below resolves against the viewport, escapes this scroll
          container, and makes the *document* taller than the window — at which
          point a `scrollIntoView` scrolls the title bar and stepper off the top
          of the app. Anchoring them here keeps `<main>` the only scroller. */}
      <main
        tabIndex={0}
        // `scroll-pb-actionzone` keeps a row the browser scrolls into view clear of
        // the action bar and the selection bar floating over this scroller.
        // Without it a focused row lands underneath them, and the keyboard user
        // cannot see what they just focused.
        className="relative min-h-0 flex-1 overflow-y-auto scroll-pb-actionzone focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_hsl(var(--border-strong))]"
        style={{ scrollbarGutter: "stable both-edges" }}
        aria-labelledby="current-stage-heading"
      >
        {/* The 1480px source-of-truth workspace. The screens that need the width are two-column —
            Review's tree beside its contents, Configure's rail beside its
            settings — and at 80rem both panes were squeezed while a 1920-pixel
            display sat half empty. The bound stays: prose inside a settings row
            still has to be readable, and an unbounded column would set a line
            length nobody can track back to the next line. */}
        <div className="workspace-frame py-4">
          {(banners || invalidated.length > 0) && (
            <div className="mb-4 space-y-3">
              {banners}
              {invalidated.length > 0 && (
                <div
                  className="flex items-start gap-3 rounded-window border border-warning/40 bg-tint-warning p-3 text-xs"
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
                      "shrink-0 rounded-panel px-2 py-1 font-medium text-warning",
                      "hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    {t("common.dismiss", undefined, "Got it")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* One banner, always in the same place, with the way out inside it.
              A lock whose exit is not obvious is indistinguishable from a bug,
              so the action sits in the explanation rather than somewhere the
              reader has to go and find. It is outside the disabled region, which
              is the only reason it stays usable. */}
          {locked && (
            <div
              className="mb-4 flex flex-wrap items-start gap-3 rounded-window border border-border bg-surface-muted p-4"
              role="status"
            >
              <FiLock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">{t("stage.locked.title")}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("stage.locked.description")}
                </p>
                {/* Said once, where the lock is explained: the one interaction
                    that survives a lock is selecting text, and a reader who
                    assumes otherwise never tries. */}
                <p className="mt-0.5 text-3xs text-faint">{t("stage.locked.selectable")}</p>
              </div>
              <Button variant="outline" onClick={() => setUnlockAsked(true)}>
                <FiEdit2 className="h-3.5 w-3.5" aria-hidden />
                {t("stage.locked.action")}
              </Button>
            </div>
          )}

          {/* A native `fieldset[disabled]` rather than `inert`. Both stop every
              control and remove it from the tab order; they differ on the one
              thing that matters here, which is that `inert` also makes the text
              inside it unselectable. A locked stage is a stage you are reading
              — folder paths, names, planned outcomes — and not being able to
              drag a cursor over a path to copy it is a worse bug than the one
              the lock was fixing.
              A stage that draws its own boundary is skipped here, because a
              disabled fieldset cannot be re-enabled from a descendant: see
              `stageDrawsOwnLock`. */}
          {/* A stage that cannot be edited has to *look* it. The boundary alone
              blocked every control and changed nothing on screen, so a locked
              Sources or Setup read as an ordinary screen whose buttons had
              stopped working — which is the complaint this answers. Disabled
              controls now carry their own `:disabled` styling, which is the
              part a reader actually recognises. */}
          <fieldset
            key={`${state.stage}:${state.key.planVersion}`}
            disabled={locked && !stageDrawsOwnLock(state.stage)}
            className={cn(
              "stage-enter m-0 min-w-0 border-0 p-0",
              locked && !stageDrawsOwnLock(state.stage) && "read-only-region",
            )}
          >
            {children(state, nav, locked)}
          </fieldset>
        </div>
      </main>

      {footer?.(state, nav)}

      <ConfirmDialog
        open={unlockAsked}
        title={t("stage.locked.confirm.title")}
        description={t("stage.locked.confirm.description")}
        confirmLabel={t("stage.locked.confirm.action")}
        cancelLabel={t("common.cancel")}
        onClose={() => setUnlockAsked(false)}
        onConfirm={() => {
          setUnlockAsked(false);
          onUnlock?.();
        }}
      />

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
