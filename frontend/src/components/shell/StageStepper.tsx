/**
 * The horizontal stepper: four named stops, each carrying its current context.
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
  onSelect: (stage: Stage, reviewView?: "plan" | "review") => void;
}

type VisualStep = {
  id: Stage;
  stage: Stage;
  labelKey: string;
  /** The full sentence, which only the tooltip has room for. */
  descriptionKey: string;
  /** Two or three words, which is what the rail can actually show. */
  hintKey: string;
};

const VISUAL_STEPS: VisualStep[] = STAGE_LABELS.map((entry) => ({
  id: entry.stage,
  stage: entry.stage,
  labelKey: `stage.${entry.stage}.label`,
  descriptionKey: `stage.${entry.stage}.description`,
  hintKey: `stage.${entry.stage}.hint`,
}));

export function StageStepper({ current, gate, complete, onSelect }: StageStepperProps) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("stage.navigation")}
      className="relative h-14 shrink-0 overflow-hidden border-b border-border bg-card md:h-stepper md:overflow-x-auto xl:h-stepper-wide"
    >
      <ol className="workspace-frame relative grid h-full min-w-0 grid-cols-1 gap-1 py-1 md:grid-cols-4">
        {VISUAL_STEPS.map((entry, index) => {
          const active = entry.stage === current;
          const isComplete = complete(entry.stage);
          const readiness = gate(entry.stage);
          const reachable = readiness.canEnter || active;
          return (
            <li key={entry.id} className={cn("min-w-0", active ? "block" : "hidden md:block")}>
              <Tooltip label={readiness.reason ?? t(entry.descriptionKey)}>
                <button
                  type="button"
                  data-stage-id={entry.id}
                  disabled={!reachable}
                  aria-current={active ? "step" : undefined}
                  aria-label={`${t(entry.labelKey)}${isComplete ? `, ${t("stage.complete")}` : ""}`}
                  onClick={() =>
                    onSelect(entry.stage, entry.stage === "review" ? "review" : undefined)
                  }
                  className={cn(
                    "relative z-[1] flex h-full w-full items-center gap-2 rounded-panel border border-transparent px-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "border-primary/40 bg-tint-primary text-foreground",
                    !active &&
                      reachable &&
                      "hover:border-border hover:bg-muted hover:text-foreground",
                    !reachable &&
                      "cursor-not-allowed border-dashed border-border bg-muted/45 text-faint",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-3xs font-bold tabular-nums",
                      active &&
                        "border-primary bg-primary text-primary-foreground shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]",
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
                    {/* A locked step shows what it is for, not why it is
                        locked. Every locked step shares one blocking reason, so
                        printing it here repeated the same sentence down the
                        whole rail; it is stated once in the footer, and this
                        row's tooltip still carries it. */}
                    <span className="mt-0.5 block truncate text-3xs font-normal text-faint">
                      {isComplete && readiness.canEnter ? t("stage.complete") : t(entry.hintKey)}
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
