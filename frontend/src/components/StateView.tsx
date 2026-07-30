import type { ReactNode } from "react";

import { useI18n } from "@/i18n/I18nContext";
import { userFacingError } from "@/lib/errorUtils";
import { severityClass, type PresentationSeverity } from "@/lib/statusPresentation";

export type StateViewVariant =
  | "empty"
  | "loading"
  | "error"
  | "blocked"
  | "success"
  | "info"
  | "warning";

const VARIANT_SEVERITY: Record<StateViewVariant, PresentationSeverity> = {
  empty: "neutral",
  loading: "info",
  error: "error",
  blocked: "warning",
  success: "success",
  info: "info",
  warning: "warning",
};

interface StateViewProps {
  variant: StateViewVariant;
  title: string;
  detail?: string | null;
  action?: ReactNode;
  onRetry?: () => void;
  compact?: boolean;
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
  action,
  onRetry,
  compact = false,
  children,
  className = "",
}: StateViewProps) {
  const { t } = useI18n();
  const safeTitle = variant === "error" ? userFacingError(title) : title;
  const safeDetail = variant === "error" && detail ? userFacingError(detail) : detail;

  return (
    <div
      className={`rounded-xl border ${severityClass(VARIANT_SEVERITY[variant])} ${
        compact ? "px-3 py-2" : "px-5 py-6 text-center"
      } ${className}`}
      data-severity={VARIANT_SEVERITY[variant]}
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "loading" ? "polite" : undefined}
      aria-busy={variant === "loading" || undefined}
    >
      <p className="text-sm font-medium">{safeTitle}</p>
      {safeDetail && <p className="mt-1 text-xs opacity-90">{safeDetail}</p>}
      {(onRetry || action) && (
        <div className={`mt-3 flex gap-2 ${compact ? "" : "justify-center"}`}>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-current px-3 py-1 text-xs"
            >
              {t("state.retry")}
            </button>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
