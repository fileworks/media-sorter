/**
 * The footer rail: one sentence on the left, one primary action on the right.
 *
 * The sentence is either a standing safety promise or the run estimate, and it
 * is deliberately quiet — a persistent line of body text rather than a banner.
 * Reassurance that shouts stops being read by the third screen.
 *
 * There is exactly one primary action per screen and it always sits in the same
 * place, so the flow can be completed without hunting.
 */

import type { ReactNode } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck } from "react-icons/fi";

import { cn } from "@/lib/utils";

interface ActionBarProps {
  /** `note` reads as a promise (green check); `estimate` reads as a figure. */
  tone?: "note" | "estimate";
  message: ReactNode;
  back?: { label: string; onClick: () => void; disabled?: boolean };
  primary?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Explains a disabled primary action; also its accessible description. */
    disabledReason?: string | null;
    busy?: boolean;
  };
  /** Extra controls between the message and the buttons. */
  children?: ReactNode;
}

export function ActionBar({ tone = "note", message, back, primary, children }: ActionBarProps) {
  const reason = primary?.disabled ? (primary.disabledReason ?? null) : null;

  return (
    <footer className="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {tone === "note" && (
          <FiCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
        )}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{message}</p>

        {children}

        {back && (
          <button
            type="button"
            onClick={back.onClick}
            disabled={back.disabled}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors",
              "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {back.label}
          </button>
        )}

        {primary && (
          <div className="flex items-center gap-2">
            {reason && (
              <span id="action-bar-reason" className="text-2xs text-faint">
                {reason}
              </span>
            )}
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabled || primary.busy}
              aria-describedby={reason ? "action-bar-reason" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground shadow-card transition-opacity",
                "hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                "disabled:cursor-not-allowed disabled:opacity-45",
              )}
            >
              {primary.label}
              <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </footer>
  );
}
