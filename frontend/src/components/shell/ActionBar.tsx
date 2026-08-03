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

import { Button } from "@/components/ui/button";

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
    <footer className="shrink-0 border-t border-border bg-card px-4 py-2.5 sm:px-6 sm:py-3">
      {/* One row once there is room for one. On a narrow window the sentence
          takes its own line and the actions stay together on the next, rather
          than the primary action wrapping away from Back. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-2xs leading-relaxed text-muted-foreground sm:text-xs">
          {tone === "note" && (
            <FiCheck
              className="mt-px h-3.5 w-3.5 shrink-0 text-success sm:h-4 sm:w-4"
              aria-hidden
            />
          )}
          <span className="min-w-0">{message}</span>
        </p>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}

          {reason && (
            <span id="action-bar-reason" className="text-2xs text-faint">
              {reason}
            </span>
          )}

          {back && (
            <Button variant="outline" size="sm" onClick={back.onClick} disabled={back.disabled}>
              <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {back.label}
            </Button>
          )}

          {/* The one primary action on the screen, in the one shape a primary
              has. This used to repaint the `default` variant by hand, which is
              a fifth definition of it that drifts the first time the palette
              moves. */}
          {primary && (
            <Button
              size="sm"
              className="px-5 font-semibold"
              onClick={primary.onClick}
              disabled={primary.disabled || primary.busy}
              aria-describedby={reason ? "action-bar-reason" : undefined}
              aria-busy={primary.busy || undefined}
            >
              {primary.busy && (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground"
                />
              )}
              {primary.label}
              {!primary.busy && <FiArrowRight className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
