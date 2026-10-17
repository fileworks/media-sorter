/**
 * Shared tone vocabulary for states, banners and operation outcomes.
 *
 * Wording is translated through `i18n/messages.ts`; this module decides only
 * which semantic tone a state or outcome carries, so one run never appears
 * amber on one screen and blue on another.
 */

export type StatusTone = "success" | "warning" | "error" | "info";
export type PresentationSeverity = StatusTone | "neutral";

const SEVERITY_CLASS: Record<PresentationSeverity, string> = {
  neutral: "border-border bg-muted/20 text-muted-foreground",
  success: "border-success/40 bg-success/5 text-success",
  info: "border-info/30 bg-info/5 text-info",
  warning: "border-warning/40 bg-warning/5 text-warning",
  error: "border-error/40 bg-error/5 text-error",
};

/** Shared semantic tokens for full-page states and distinct notification banners. */
export function severityClass(severity: PresentationSeverity): string {
  return SEVERITY_CLASS[severity];
}

export type OperationOutcome =
  "completed" | "completed_with_warnings" | "partial" | "cancelled" | "failed";

export interface OutcomeView {
  tone: StatusTone;
}

/**
 * The one place an operation outcome's tone is decided. Wording lives in the
 * translated `report.outcome.*` keys, so this returns no English text.
 */
export function presentOutcome(outcome: OperationOutcome): OutcomeView {
  switch (outcome) {
    case "completed":
      return { tone: "success" };
    case "completed_with_warnings":
    case "partial":
      return { tone: "warning" };
    case "cancelled":
      return { tone: "info" };
    case "failed":
      return { tone: "error" };
  }
}
