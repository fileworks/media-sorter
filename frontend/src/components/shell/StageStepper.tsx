/**
 * The horizontal stepper: six named stops, each carrying its current context.
 *
 * Three states, and each is a different shape rather than a different colour
 * alone — filled accent pill for the current stage, a check in a green disc for
 * a finished one, a hollow ring for one not reached yet — so the flow is
 * readable without relying on colour perception.
 *
 * A stage that cannot be entered is a disabled button, not a missing one: the
 * shape of the flow should not change as prerequisites are met.
 */

import { FiCheck } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { STAGE_LABELS, type Stage, type StageReadiness } from "@/lib/stageModel";

interface StageStepperProps {
  current: Stage;
  gate: (stage: Stage) => StageReadiness;
  complete: (stage: Stage) => boolean;
  /** A finished dry run turns the visual Plan step into Review. */
  planReady: boolean;
  reviewView: "plan" | "review";
  onSelect: (stage: Stage, reviewView?: "plan" | "review") => void;
}

type VisualStep = {
  id: Stage | "plan";
  stage: Stage;
  labelKey: string;
  descriptionKey: string;
};

const VISUAL_STEPS: VisualStep[] = [
  ...STAGE_LABELS.slice(0, 3).map((entry) => ({
    id: entry.stage,
    stage: entry.stage,
    labelKey: `stage.${entry.stage}.label`,
    descriptionKey: `stage.${entry.stage}.description`,
  })),
  {
    id: "plan",
    stage: "review",
    labelKey: "stage.plan.label",
    descriptionKey: "stage.plan.description",
  },
  {
    id: "review",
    stage: "review",
    labelKey: "stage.review.label",
    descriptionKey: "stage.review.description",
  },
  {
    id: "execute",
    stage: "execute",
    labelKey: "stage.execute.label",
    descriptionKey: "stage.execute.description",
  },
];

export function StageStepper({
  current,
  gate,
  complete,
  planReady,
  reviewView,
  onSelect,
}: StageStepperProps) {
  const { t } = useI18n();
  const activeIndex = VISUAL_STEPS.findIndex((entry) =>
    entry.id === "plan"
      ? current === "review" && reviewView === "plan"
      : entry.id === "review"
        ? current === "review" && reviewView === "review"
        : entry.stage === current,
  );
  const progress = Math.max(0, activeIndex) / (VISUAL_STEPS.length - 1);

  return (
    <nav
      aria-label={t("stage.navigation")}
      className="relative h-16 shrink-0 overflow-hidden border-b border-border bg-card md:h-stepper md:overflow-x-auto xl:h-stepper-wide"
    >
      <div
        className="pointer-events-none absolute inset-x-4 bottom-1 mx-auto h-0.5 max-w-workspace overflow-hidden rounded-full bg-border"
        aria-hidden
      >
        <span
          className="block h-full origin-left rounded-full bg-primary transition-transform duration-300"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>
      <ol className="relative mx-auto grid h-full min-w-0 max-w-workspace grid-cols-1 gap-1 px-3 pb-2 pt-1.5 md:min-w-[48rem] md:grid-cols-6 md:px-4">
        {VISUAL_STEPS.map((entry, index) => {
          const active =
            entry.id === "plan"
              ? current === "review" && reviewView === "plan"
              : entry.id === "review"
                ? current === "review" && reviewView === "review"
                : entry.stage === current;
          const isComplete =
            entry.id === "plan"
              ? planReady
              : entry.id === "review"
                ? complete("review")
                : complete(entry.stage);
          const baseReadiness = gate(entry.stage);
          const readiness: StageReadiness =
            entry.id === "review" && !planReady
              ? { canEnter: false, reason: t("stage.review.planNeeded") }
              : baseReadiness;
          const reachable = readiness.canEnter || active;
          return (
            <li key={entry.id} className={cn("min-w-0", active ? "block" : "hidden md:block")}>
              <Tooltip label={readiness.reason ?? t(entry.descriptionKey)}>
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={active ? "step" : undefined}
                  aria-label={`${t(entry.labelKey)}${isComplete ? `, ${t("stage.complete")}` : ""}`}
                  onClick={() =>
                    onSelect(
                      entry.stage,
                      entry.id === "plan" ? "plan" : entry.id === "review" ? "review" : undefined,
                    )
                  }
                  className={cn(
                    "relative z-[1] flex h-full w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "border-primary/30 bg-tint-primary text-foreground",
                    !active &&
                      reachable &&
                      "hover:border-border hover:bg-muted hover:text-foreground",
                    !reachable && "cursor-not-allowed",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-3xs font-bold tabular-nums",
                      active &&
                        "border-primary bg-primary text-primary-foreground shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]",
                      isComplete && !active && "border-success/40 bg-tint-success text-success",
                      !active && !isComplete && "border border-border text-faint",
                    )}
                    aria-hidden
                  >
                    {isComplete && !active ? <FiCheck className="h-3 w-3" /> : index + 1}
                  </span>
                  <span className="min-w-0" aria-hidden>
                    <span
                      className={cn(
                        "block truncate text-xs font-semibold",
                        active
                          ? "text-foreground"
                          : isComplete
                            ? "text-muted-foreground"
                            : "text-faint",
                      )}
                    >
                      {t(entry.labelKey)}
                    </span>
                    <span className="mt-0.5 block truncate text-3xs font-normal text-faint">
                      {readiness.canEnter
                        ? isComplete
                          ? t("stage.complete")
                          : t(entry.descriptionKey)
                        : readiness.reason}
                    </span>
                  </span>
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
