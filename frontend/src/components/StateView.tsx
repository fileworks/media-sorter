import type { ReactNode } from "react";

import { useI18n } from "@/i18n/I18nContext";
import { userFacingError } from "@/lib/errorUtils";
import { severityClass, type PresentationSeverity } from "@/lib/statusPresentation";
import { cn } from "@/lib/utils";

export type StateViewVariant =
  "empty" | "loading" | "error" | "blocked" | "success" | "info" | "warning";

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
};

interface StateViewProps {
  variant: StateViewVariant;
  title: string;
  detail?: string | null;
  /** The envelope's stable identifier, shown beside the message for bug reports. */
  code?: string | null;
  action?: ReactNode;
  onRetry?: () => void;
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
  compact = false,
  layout = "inline",
  children,
  className = "",
}: StateViewProps) {
  const { t } = useI18n();
  const safeTitle = variant === "error" ? userFacingError(title) : title;
  const safeDetail = variant === "error" && detail ? userFacingError(detail) : detail;
  const centred = !compact;

  const card = (
    <div
      className={cn(
        "rounded-xl border",
        severityClass(VARIANT_SEVERITY[variant]),
        compact ? "px-3 py-2" : "px-5 py-6 text-center",
        layout === "page" && "w-full max-w-md",
        className,
      )}
      data-severity={VARIANT_SEVERITY[variant]}
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "loading" ? "polite" : undefined}
      aria-busy={variant === "loading" || undefined}
    >
      <p className="text-sm font-medium">{safeTitle}</p>
      {(safeDetail || code) && (
        <p className="mt-1 text-xs leading-relaxed opacity-90">
          {safeDetail}
          {code && (
            <code className={cn("font-mono opacity-70", safeDetail && "ml-1.5")}>{code}</code>
          )}
        </p>
      )}
      {(onRetry || action) && (
        <div className={cn("mt-3 flex flex-wrap gap-2", centred && "justify-center")}>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-current px-3 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

  if (layout !== "page") return card;

  return (
    <div className="flex min-h-[55dvh] w-full items-center justify-center px-2 py-6">{card}</div>
  );
}
