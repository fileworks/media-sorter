/**
 * What the application is doing between the window appearing and the first
 * screen being usable.
 *
 * Starting MediaSorter is not one act. The Tauri shell picks a free port and
 * launches the Python backend, the client asks the shell which port that was,
 * the backend answers a health check, and only then is there a configuration
 * to draw a screen from. On a warm machine that is under a second; on a cold
 * one — a first launch, a slow disk, a virus scanner reading a freshly
 * unpacked binary — it is comfortably long enough to look like a hang.
 *
 * Until now the whole of it was one static "Starting up…" in `index.html`
 * followed by an unlabelled spinner, so a start that took twenty seconds and a
 * start that had failed were the same picture. Each step is named here, and
 * the one currently running says so.
 *
 * Deliberately not a progress bar. None of these steps has a measurable
 * fraction, and a bar that invents one is worse than a list that does not.
 */

import { useEffect, useState } from "react";
import { FiAlertTriangle, FiCheck } from "react-icons/fi";

import { AppMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import type { StartupStep, StartupStepState } from "@/lib/startupProgress";
import { cn } from "@/lib/utils";

/** How long a start may take before it is worth saying that this is normal. */
const SLOW_AFTER_SECONDS = 8;

function StepIcon({ state, index }: { state: StartupStepState; index: number }) {
  if (state === "done") {
    return (
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-success/40 bg-tint-success text-success"
      >
        <FiCheck className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-error/40 bg-tint-error text-error"
      >
        <FiAlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === "running") {
    return (
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-primary bg-tint-primary"
      >
        {/* `motion-reduce` rather than a media query in CSS: the spinner is the
            only thing on this screen that moves, so it is also the only thing
            that has to stop. */}
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary/40 border-t-primary motion-reduce:animate-none" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border text-3xs font-bold tabular-nums text-faint"
    >
      {index + 1}
    </span>
  );
}

interface StartupScreenProps {
  steps: StartupStep[];
  /** The reason the start cannot continue, when one is known. */
  failure: string | null;
  onRetry: () => void;
}

export function StartupScreen({ steps, failure, onRetry }: StartupScreenProps) {
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  const failed = failure !== null || steps.some((step) => step.state === "failed");

  useEffect(() => {
    if (failed) return;
    const id = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(id);
  }, [failed]);

  const running = steps.find((step) => step.state === "running") ?? null;

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-tint-primary">
            <AppMark className="h-8 w-8" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight text-foreground">MediaSorter</h1>
            {/* One line naming the step in progress, so the state of the start
                is legible without reading the list. */}
            <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">
              {failed ? t("startup.failedTitle") : (running?.label ?? t("startup.almostReady"))}
            </p>
          </div>
        </div>

        <ol
          className="overflow-hidden rounded-window border border-border bg-card"
          aria-label={t("startup.title")}
        >
          {steps.map((step, index) => (
            <li
              key={step.id}
              aria-current={step.state === "running" ? "step" : undefined}
              className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
            >
              <StepIcon state={step.state} index={index} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-xs font-semibold",
                    step.state === "pending" ? "text-faint" : "text-foreground",
                  )}
                >
                  {step.label}
                  <span className="sr-only">{` — ${t(`startup.state.${step.state}`)}`}</span>
                </p>
                <p className="mt-0.5 text-3xs leading-relaxed text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>

        {failed ? (
          <div className="mt-4">
            <p role="alert" className="text-xs leading-relaxed text-error">
              {failure ?? t("startup.failedHelp")}
            </p>
            <Button size="sm" className="mt-3" onClick={onRetry}>
              {t("app.reload")}
            </Button>
          </div>
        ) : (
          // A start that is merely slow is not a start that is broken, and the
          // difference is worth stating before somebody force-quits.
          elapsed >= SLOW_AFTER_SECONDS && (
            <p className="mt-4 text-3xs leading-relaxed text-muted-foreground" role="status">
              {t("startup.slow")}
            </p>
          )
        )}
      </div>
    </div>
  );
}
