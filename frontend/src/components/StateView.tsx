import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

import { useI18n } from "@/i18n/I18nContext";
import { userFacingError } from "@/lib/errorUtils";
import { severityClass, type PresentationSeverity } from "@/lib/statusPresentation";
import { cn } from "@/lib/utils";

export type StateViewVariant =
  | "empty"
  | "loading"
  | "error"
  | "blocked"
  | "success"
  | "info"
  | "warning"
  /** The run finished, but not all of the work it described was done. */
  | "partial"
  /** Shown values were derived from inputs that have since changed (I-14). */
  | "stale-derived"
  /** The user stopped it. Nothing went wrong, so this is not a warning. */
  | "cancelled";

/**
 * `inline` sits in the flow, as one panel among several. `page` is the whole
 * screen's answer — the backend is gone, the settings would not load — and gets
 * centred in the space the content would have filled, at a readable measure,
 * instead of stretching a sentence across a 1280px window and pinning it to the
 * top-left corner.
 */
export type StateViewLayout = "inline" | "page";

const VARIANT_SEVERITY: Record<StateViewVariant, PresentationSeverity> = {
  empty: "neutral",
  loading: "info",
  error: "error",
  blocked: "warning",
  success: "success",
  info: "info",
  warning: "warning",
  // Matching `presentOutcome`, which is where this vocabulary already lives:
  // a partial run is a warning, a cancelled one is information. A second
  // opinion about the same words is how two screens start disagreeing.
  partial: "warning",
  "stale-derived": "warning",
  cancelled: "info",
};

/**
 * The accessibility contract, as a table rather than a chain of ternaries.
 *
 * `alert` is assertive: it interrupts whatever the screen reader is saying, so
 * it is reserved for the one variant that reports something broken. Every other
 * variant that appears in response to work finishing, stopping, or going stale
 * is announced politely — it is news, not an emergency — and the states that
 * are simply how a panel started render silently.
 */
const ANNOUNCED: ReadonlySet<StateViewVariant> = new Set<StateViewVariant>([
  "loading",
  "partial",
  "stale-derived",
  "cancelled",
]);

function roleFor(variant: StateViewVariant): "alert" | "status" {
  return variant === "error" ? "alert" : "status";
}

function ariaLiveFor(variant: StateViewVariant): "polite" | undefined {
  return ANNOUNCED.has(variant) ? "polite" : undefined;
}

interface StateViewProps {
  variant: StateViewVariant;
  title: string;
  detail?: string | null;
  /** The envelope's stable identifier, shown beside the message for bug reports. */
  code?: string | null;
  action?: ReactNode;
  onRetry?: () => void;
  /**
   * Whether this state can be recovered from. Orthogonal to `variant`: an
   * error may be either, and so may a partial run. `false` suppresses the
   * retry affordance, because offering a retry that cannot work is worse than
   * offering none. Left undefined, a supplied `onRetry` is shown as before.
   */
  recoverable?: boolean;
  compact?: boolean;
  layout?: StateViewLayout;
  children?: ReactNode;
  className?: string;
}

/**
 * The single presentation contract for a screen that cannot show its content.
 *
 * Error capture remains in ErrorBoundary/query hooks; this component only
 * guarantees that captured failures are mapped, accessible, and actionable.
 */
export function StateView({
  variant,
  title,
  detail,
  code,
  action,
  onRetry,
  recoverable,
  compact = false,
  layout = "inline",
  children,
  className = "",
}: StateViewProps) {
  const { t } = useI18n();
  const safeTitle = variant === "error" ? userFacingError(title) : title;
  const safeDetail = variant === "error" && detail ? userFacingError(detail) : detail;
  const centred = !compact;
  const retry = recoverable === false ? undefined : onRetry;

  const card = (
    <div
      className={cn(
        "rounded-window border",
        severityClass(VARIANT_SEVERITY[variant]),
        compact ? "px-3 py-2" : "px-5 py-6 text-center",
        layout === "page" && "w-full max-w-md",
        className,
      )}
      data-severity={VARIANT_SEVERITY[variant]}
      role={roleFor(variant)}
      aria-live={ariaLiveFor(variant)}
      aria-busy={variant === "loading" || undefined}
    >
      {layout === "page" ? (
        <h1 id="current-stage-heading" className="text-sm font-medium">
          {safeTitle}
        </h1>
      ) : (
        <p className="text-sm font-medium">{safeTitle}</p>
      )}
      {(safeDetail || code) && (
        <p className="mt-1 text-xs leading-relaxed">
          {safeDetail}
          {code && <code className={cn("font-mono", safeDetail && "ml-2")}>{code}</code>}
        </p>
      )}
      {(retry || action) && (
        <div className={cn("mt-3 flex flex-wrap gap-2", centred && "justify-center")}>
          {retry && (
            <Button variant="outline" size="sm" onClick={retry}>
              {t("state.retry")}
            </Button>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );

  if (layout !== "page") return card;

  return (
    <div className="flex min-h-[55dvh] w-full items-center justify-center px-2 py-6">{card}</div>
  );
}
