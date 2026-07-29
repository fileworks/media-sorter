/**
 * One way to say what happened, everywhere it is said.
 *
 * Every failure the user meets arrives here first: a stable diagnostic code, a
 * plain-language impact, whether their originals are still safe, and what they
 * can do next. The technical detail is kept — it is just not the headline, and
 * it is never a stack trace.
 */

export type SourceSafety =
  | "source_verified"
  | "source_retained"
  | "destination_verified"
  | "redundant_verified_copies"
  | "ambiguous";

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

export interface StatusAction {
  /** Stable id the UI maps to a handler; never a translated string. */
  id: "retry" | "reconnect" | "open_report" | "open_logs" | "review_recovery" | "open_quarantine";
  label: string;
}

export interface StatusPresentation {
  tone: StatusTone;
  /** Stable, greppable, and safe to show. */
  code: string;
  headline: string;
  impact: string;
  safety: string;
  actions: StatusAction[];
  /** Expandable, not the primary message. */
  technicalDetail: string | null;
  /** What a screen reader should announce, and how urgently. */
  announcement: { message: string; assertive: boolean };
}

interface KnownDiagnostic {
  tone: StatusTone;
  headline: string;
  impact: string;
  actions: StatusAction["id"][];
}

/**
 * The codes the backend can actually emit. An unknown code still produces a
 * usable message — it just says so, rather than pretending to know the cause.
 */
const DIAGNOSTICS: Record<string, KnownDiagnostic> = {
  destination_unavailable: {
    tone: "error",
    headline: "The destination disconnected",
    impact:
      "Work stopped at the last verified file. Nothing was removed from your sources after that point.",
    actions: ["reconnect", "retry", "open_report"],
  },
  destination_full: {
    tone: "error",
    headline: "The destination ran out of space",
    impact: "Files already written are complete and verified. The remaining files were not started.",
    actions: ["retry", "open_report"],
  },
  source_unreadable: {
    tone: "error",
    headline: "A source folder could not be read",
    impact: "That folder was skipped. Everything else was processed normally.",
    actions: ["retry", "open_logs"],
  },
  integrity_mismatch: {
    tone: "error",
    headline: "A copy did not match its original",
    impact: "The bad copy was discarded and the original was left untouched.",
    actions: ["open_report", "open_logs"],
  },
  reference_root_is_immutable: {
    tone: "warning",
    headline: "That folder is comparison-only",
    impact: "Reference folders are compared against but never changed, so the action was refused.",
    actions: [],
  },
  metadata_limitation: {
    tone: "warning",
    headline: "Some timestamps could not be preserved",
    impact:
      "The files themselves are byte-identical. Only the filesystem timestamp precision differs.",
    actions: ["open_report"],
  },
  quality_contract_unmet: {
    tone: "warning",
    headline: "The optimized result did not meet its contract",
    impact: "Nothing replaced your file. The original is exactly where it was.",
    actions: ["open_report"],
  },
  temporary_space_limit: {
    tone: "info",
    headline: "Skipped to stay inside the temporary-space limit",
    impact: "The file was left alone. Raising the limit in settings would include it next time.",
    actions: [],
  },
  encoder_failed: {
    tone: "warning",
    headline: "The encoder could not produce a result",
    impact: "The original is unchanged and still in place.",
    actions: ["open_logs"],
  },
  action_journal_unavailable: {
    tone: "warning",
    headline: "Running without a recovery journal",
    impact:
      "Every file is still verified, but an interrupted run cannot be reconciled automatically.",
    actions: ["open_logs"],
  },
  reconciliation_required: {
    tone: "warning",
    headline: "An interrupted operation needs review",
    impact: "At least one verified copy of every affected file exists. Nothing was lost.",
    actions: ["review_recovery", "open_report"],
  },
};

const SAFETY_TEXT: Record<SourceSafety, string> = {
  source_verified: "Your original was verified before anything else happened.",
  source_retained: "Your original is untouched and still in its original location.",
  destination_verified: "The copy at the destination was verified byte for byte.",
  redundant_verified_copies: "Two verified copies exist — the original is in quarantine.",
  ambiguous: "This one needs review: which copy is authoritative could not be determined.",
};

const ACTION_LABELS: Record<StatusAction["id"], string> = {
  retry: "Try again",
  reconnect: "Reconnect and resume",
  open_report: "Open the report",
  open_logs: "Show technical details",
  review_recovery: "Review recovery",
  open_quarantine: "Open quarantine",
};

export interface StatusInput {
  code: string | null | undefined;
  safety?: SourceSafety;
  /** Raw backend message; shown only behind the expander. */
  detail?: string | null;
  /** Automatic retries already performed, so the user is not told to wait twice. */
  retriesPerformed?: number;
}

export function presentStatus(input: StatusInput): StatusPresentation {
  const code = input.code ?? "unknown_error";
  const known = DIAGNOSTICS[code];
  const tone: StatusTone = known?.tone ?? "error";
  const headline = known?.headline ?? "Something went wrong";
  const impactBase =
    known?.impact ??
    "The operation stopped. Nothing was removed from a source that had not been verified first.";
  const retryNote =
    input.retriesPerformed && input.retriesPerformed > 0
      ? ` Retried automatically ${input.retriesPerformed} time${input.retriesPerformed === 1 ? "" : "s"} first.`
      : "";
  const safety = SAFETY_TEXT[input.safety ?? "source_retained"];
  const actions = (known?.actions ?? ["open_logs"]).map((id) => ({ id, label: ACTION_LABELS[id] }));

  return {
    tone,
    code,
    headline,
    impact: impactBase + retryNote,
    safety,
    actions,
    technicalDetail: input.detail?.trim() ? input.detail.trim() : null,
    announcement: {
      message: `${headline}. ${impactBase}`,
      assertive: tone === "error",
    },
  };
}

/** True when a raw message looks like a stack trace and must stay collapsed. */
export function looksLikeStackTrace(detail: string): boolean {
  return /(\n\s+at |Traceback \(most recent call last\)|File ".*", line \d+)/.test(detail);
}

export type OperationOutcome =
  | "completed"
  | "completed_with_warnings"
  | "partial"
  | "cancelled"
  | "failed";

export interface OutcomeView {
  tone: StatusTone;
  headline: string;
  /** Present only when there is something specific to do next. */
  nextStep: string | null;
}

export function presentOutcome(outcome: OperationOutcome, warnings: number): OutcomeView {
  switch (outcome) {
    case "completed":
      return { tone: "success", headline: "Finished", nextStep: null };
    case "completed_with_warnings":
      return {
        tone: "warning",
        headline: `Finished with ${warnings} warning${warnings === 1 ? "" : "s"}`,
        nextStep: "Open the report to see which files were affected.",
      };
    case "partial":
      return {
        tone: "warning",
        headline: "Partly finished",
        nextStep: "Some files still need review before this run can be considered complete.",
      };
    case "cancelled":
      return {
        tone: "info",
        headline: "Cancelled",
        nextStep: "Files already processed are complete and verified.",
      };
    case "failed":
      return {
        tone: "error",
        headline: "Failed",
        nextStep: "Your sources were not removed. Check the report before retrying.",
      };
  }
}
