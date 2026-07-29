/**
 * One way to show a failure: impact first, stack trace never.
 *
 * The headline says what happened, the next line says whether the user's
 * originals are still safe, and the technical detail stays behind an expander
 * with its diagnostic code visible for support. Errors are announced
 * assertively; warnings wait their turn.
 */

import { StateView, type StateViewVariant } from "@/components/StateView";
import { presentStatus, type StatusAction, type StatusInput } from "@/lib/statusPresentation";

interface StatusMessageProps extends StatusInput {
  /** Called with the stable action id; the caller owns what each one does. */
  onAction?: (action: StatusAction["id"]) => void;
  className?: string;
}

const TONE_VARIANT: Record<ReturnType<typeof presentStatus>["tone"], StateViewVariant> = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
} as const;

export function StatusMessage({ onAction, className = "", ...input }: StatusMessageProps) {
  const status = presentStatus(input);

  return (
    <StateView
      variant={TONE_VARIANT[status.tone]}
      title={status.headline}
      detail={`${status.impact} ${status.safety}`}
      compact
      className={className}
      action={
        status.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {status.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => onAction?.(action.id)}
                className="rounded-lg border border-border px-3 py-1 text-xs text-foreground hover:border-primary"
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      {status.technicalDetail && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Technical details ({status.code})
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
            {status.technicalDetail}
          </pre>
        </details>
      )}
    </StateView>
  );
}
