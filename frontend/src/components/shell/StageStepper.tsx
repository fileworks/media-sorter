/**
 * The horizontal stepper: four numbered stops, joined by hairlines.
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
import { STAGE_LABELS, stageIndex, type Stage, type StageReadiness } from "@/lib/stageModel";

interface StageStepperProps {
  current: Stage;
  gate: (stage: Stage) => StageReadiness;
  onSelect: (stage: Stage) => void;
}

export function StageStepper({ current, gate, onSelect }: StageStepperProps) {
  const { t } = useI18n();
  const currentIndex = stageIndex(current);

  return (
    <nav
      aria-label={t("stage.navigation")}
      className="shrink-0 overflow-x-auto border-b border-border bg-card"
    >
      <ol className="flex min-w-max items-center gap-1 px-4 py-2.5 sm:px-5">
        {STAGE_LABELS.map((entry, index) => {
          const active = entry.stage === current;
          const complete = index < currentIndex;
          const readiness = gate(entry.stage);
          const reachable = readiness.canEnter || active;
          return (
            <li key={entry.stage} className="flex items-center gap-1">
              {index > 0 && <span className="mr-1 h-px w-5 bg-border sm:w-6" aria-hidden />}
              <Tooltip label={readiness.reason ?? t(`stage.${entry.stage}.description`)}>
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={active ? "step" : undefined}
                  aria-label={t(`stage.${entry.stage}.label`)}
                  onClick={() => onSelect(entry.stage)}
                  className={cn(
                    "flex items-center gap-2 rounded-full py-1 pl-1.5 pr-3 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-tint-primary",
                    !active && reachable && "hover:bg-muted",
                    !reachable && "cursor-not-allowed",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-3xs font-bold",
                      active && "bg-primary text-primary-foreground",
                      complete && !active && "bg-tint-success text-success",
                      !active && !complete && "border border-border text-faint",
                    )}
                    aria-hidden
                  >
                    {complete && !active ? <FiCheck className="h-3 w-3" /> : index + 1}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "whitespace-nowrap text-xs",
                      active
                        ? "font-semibold text-primary"
                        : complete
                          ? "text-muted-foreground"
                          : "text-faint",
                    )}
                  >
                    {t(`stage.${entry.stage}.label`)}
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
