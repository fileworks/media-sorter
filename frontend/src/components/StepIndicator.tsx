import type { FC } from "react";
import { cn } from "@/lib/utils";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

const STEPS: { n: number; label: string }[] = [
  { n: 1, label: "Configure" },
  { n: 2, label: "Analyze" },
  { n: 3, label: "Preview" },
  { n: 4, label: "Sort" },
  { n: 5, label: "Report" },
];

interface StepIndicatorProps {
  current: WizardStep;
  /** Steps that have valid results and should render with a completion checkmark. */
  doneSteps: ReadonlySet<WizardStep>;
  /** Highest step the user may navigate to (derived from actual progress). */
  maxReached: WizardStep;
  onStepClick: (step: WizardStep) => void;
}

export const StepIndicator: FC<StepIndicatorProps> = ({
  current,
  doneSteps,
  maxReached,
  onStepClick,
}) => (
  <nav aria-label="Wizard progress" className="flex items-center justify-center gap-0 pt-4 pb-1">
    {STEPS.map(({ n, label }, i) => {
      const isActive = n === current;
      // Done = has valid results AND not the currently-viewed step (active overrides done styling)
      const isDone = doneSteps.has(n as WizardStep) && !isActive;
      const isReachable = n <= maxReached;
      // Furthest = the highest step reached, while the user is currently viewing
      // an earlier one. It stays highlighted so the latest progress point is
      // always obvious — even mid-computation (e.g. sorting on step 4 while the
      // user browses back to step 1). With no checkmark yet it's still running,
      // so it gets a gentle pulse to read as "in progress here".
      const isFurthest = n === maxReached && !isActive && maxReached > 1;
      const isInProgress = isFurthest && !isDone;
      // Connector is filled if this step is done or the user is at/past it
      const connectorFilled = n <= current || doneSteps.has(n as WizardStep);

      return (
        <div key={n} className="flex items-start">
          {/* Connector line — mt-4 = 16px = half of h-8 circle, centres on the circle */}
          {i > 0 && (
            <div className="mt-4 h-0.5 w-8 sm:w-12 overflow-hidden rounded-full bg-border">
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-all duration-500 ease-out origin-left",
                  connectorFilled ? "w-full" : "w-0",
                )}
              />
            </div>
          )}

          {/* Step item */}
          <button
            type="button"
            disabled={!isReachable}
            onClick={() => isReachable && onStepClick(n as WizardStep)}
            className="flex flex-col items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-current={isActive ? "step" : isFurthest ? "location" : undefined}
            aria-label={`Step ${n}: ${label}${
              isDone
                ? " (complete)"
                : isActive
                  ? " (current)"
                  : isInProgress
                    ? " (in progress)"
                    : ""
            }`}
          >
            {/* Circle */}
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300",
                isActive
                  ? "scale-110 bg-primary text-primary-foreground shadow-md ring-2 ring-primary/40 ring-offset-2 ring-offset-background"
                  : isFurthest
                    ? // Latest reached step (not currently viewed): keep it primary-
                      // tinted with a ring so it always stands out as the frontier.
                      cn(
                        "bg-primary/15 text-primary ring-2 ring-primary/40 ring-offset-2 ring-offset-background hover:bg-primary/25 cursor-pointer",
                        isInProgress && "animate-pulse",
                      )
                    : isDone
                      ? "bg-primary/15 text-primary hover:bg-primary/25 cursor-pointer"
                      : isReachable
                        ? "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
                        : "bg-muted text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              {isDone ? (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 12 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 5l3 3 7-7" />
                </svg>
              ) : (
                n
              )}
            </span>

            {/* Label — always shown on desktop */}
            <span
              className={cn(
                "text-[11px] font-medium leading-none whitespace-nowrap",
                isActive
                  ? "text-primary"
                  : isFurthest
                    ? "text-primary/80"
                    : isDone
                      ? "text-primary/60"
                      : "text-muted-foreground/60",
              )}
            >
              {label}
            </span>
          </button>
        </div>
      );
    })}
  </nav>
);
