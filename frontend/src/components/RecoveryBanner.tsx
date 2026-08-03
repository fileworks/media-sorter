/**
 * What the app says after it was interrupted, and what it refuses to do next.
 *
 * Leftovers the backend could match to a verified copy are reported as already
 * handled. Anything it could not is listed individually and blocks a new run —
 * not because the app is fragile, but because starting fresh over ambiguous
 * artifacts is how the one remaining copy of something gets overwritten.
 */

import { buildRecoveryPlan, type RecoveryOperation } from "@/lib/startupRecovery";
import { Button } from "@/components/ui/button";
import { redactRoot } from "@/lib/pathUtils";
import { severityClass } from "@/lib/statusPresentation";

interface RecoveryBannerProps {
  operation: RecoveryOperation;
  /** Resolve one ambiguous artifact; the caller performs the decision. */
  onDecide?: (actionId: string, decision: "keep" | "discard") => void;
  onOpenReport?: (operationId: string) => void;
}

export function RecoveryBanner({ operation, onDecide, onOpenReport }: RecoveryBannerProps) {
  const plan = buildRecoveryPlan(operation);
  const severity = plan.blocksNewOperations ? "warning" : "info";

  return (
    <section
      className={`rounded-lg border p-3 ${severityClass(severity)}`}
      data-severity={severity}
      role={plan.blocksNewOperations ? "alert" : "status"}
      aria-live={plan.blocksNewOperations ? "assertive" : "polite"}
    >
      <h2 className="text-sm font-medium text-foreground">{plan.headline}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{plan.guidance}</p>

      {plan.automatic.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {plan.automatic.length} leftover
          {plan.automatic.length === 1 ? " was" : "s were"} resolved automatically.
        </p>
      )}

      {plan.decisions.length > 0 && (
        <ul className="mt-3 space-y-2">
          {plan.decisions.map(({ artifact, explanation }) => (
            <li
              key={artifact.action_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-foreground">{redactRoot(artifact.path)}</p>
                <p className="text-2xs text-muted-foreground">{explanation}</p>
              </div>
              {onDecide && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDecide(artifact.action_id, "keep")}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDecide(artifact.action_id, "discard")}
                  >
                    Discard
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {onOpenReport && (
        <button
          type="button"
          onClick={() => onOpenReport(plan.operationId)}
          className="mt-3 rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
        >
          Open the report
        </button>
      )}
    </section>
  );
}
