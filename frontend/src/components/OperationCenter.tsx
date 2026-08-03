/**
 * The persistent operation center, and the Execute preflight.
 *
 * The center stays available while you look at something else: an operation
 * that is running has to be findable without navigating back to wherever it was
 * started. The preflight is its opposite — a screen you read once, carefully,
 * before anything moves.
 */

import { useState } from "react";
import { FiActivity, FiChevronDown } from "react-icons/fi";

import { StatusMessage } from "@/components/StatusMessage";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { formatBytesShort } from "@/lib/optimizationProjection";
import {
  centerBadge,
  centerState,
  preflight,
  reportView,
  type OperationSummary,
  type PreflightInput,
} from "@/lib/operationCenter";
import { useOperationLiveness } from "@/hooks/useOperationLiveness";
import type { TaskProgress } from "@/types/api";

const TONE_CLASS = {
  neutral: "text-muted-foreground",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
} as const;

interface OperationCenterProps {
  operations: OperationSummary[];
  seen?: string[];
  progress?: TaskProgress | null;
  activePath?: string | null;
  onOpen?: (kind: string, id: string) => void;
}

export function OperationCenter({
  operations,
  seen = [],
  progress = null,
  activePath = null,
  onOpen,
}: OperationCenterProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const state = centerState(operations, seen);
  const badge = centerBadge(state);
  const badgeTitle = state.active
    ? t("operations.inProgress", {
        kind: t(`operations.kind.${state.active.kind}`),
      })
    : state.recent.some(
          (operation) => operation.recoveryState === "required" || operation.counts.failed > 0,
        )
      ? t("operations.needsAttention")
      : state.unread.length > 0
        ? t("operations.finishedWarnings")
        : t("operations.nothingRunning");
  const { view, message } = useOperationLiveness(progress, { activePath });

  return (
    <section className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <FiActivity className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">
            {t("operations.title")}
          </span>
          <span className={`block truncate text-2xs ${TONE_CLASS[badge.tone]}`}>
            {badge.count > 0 ? `${badge.count} · ${badgeTitle}` : badgeTitle}
          </span>
        </span>
        <FiChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {state.active && (
        <div className="border-t border-border px-3 py-2" role="status" aria-live="polite">
          <p className="text-sm text-foreground">
            {t("operations.inProgress", {
              kind: t(`operations.kind.${state.active.kind}`),
            })}
          </p>
          {message && <p className="text-xs text-muted-foreground">{message.message}</p>}
          {view?.determinate && view.percentage !== null && (
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${view.percentage}%` }} />
            </div>
          )}
        </div>
      )}

      {expanded && (
        <ul className="divide-y divide-border border-t border-border">
          {state.recent.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">{t("operations.empty")}</li>
          ) : (
            state.recent.slice(0, 20).map((operation) => {
              const report = reportView(operation);
              return (
                <li key={operation.operationId} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-foreground">
                      {t(`operations.kind.${operation.kind}`)} · {report.headline}
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      {t("operations.written", {
                        bytes: formatBytesShort(operation.bytesWritten),
                      })}
                    </span>
                  </div>
                  {report.facts.length > 0 && (
                    <dl className="mt-1 flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
                      {report.facts.map((fact) => (
                        <span key={fact.label}>
                          {fact.label}: {fact.value}
                        </span>
                      ))}
                    </dl>
                  )}
                  {report.nextSteps.length > 0 && (
                    <p className="mt-1 text-2xs text-warning">{report.nextSteps[0]}</p>
                  )}
                  {onOpen && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {report.links.map((link) => (
                        <button
                          key={`${link.kind}:${link.id}`}
                          type="button"
                          onClick={() => onOpen(link.kind, link.id)}
                          className="rounded border border-border px-2 py-0.5 text-2xs hover:border-primary"
                        >
                          {link.kind}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </section>
  );
}

interface ExecutePreflightProps {
  input: PreflightInput;
  onAcknowledge: (acknowledged: boolean) => void;
  onExecute: () => void;
  busy?: boolean;
}

export function ExecutePreflight({
  input,
  onAcknowledge,
  onExecute,
  busy = false,
}: ExecutePreflightProps) {
  const { t } = useI18n();
  const result = preflight(input);
  const lineText = (line: (typeof result.reversible)[number]) =>
    line.messageKey ? t(line.messageKey, line.params, line.text) : line.text;

  return (
    <section
      className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-card"
      aria-label={t("preflight.title")}
    >
      <section className="rounded-xl bg-muted/60 p-4" aria-labelledby="rerunnable-effects">
        <h2 id="rerunnable-effects" className="text-sm font-semibold text-foreground">
          {t("preflight.reversible.title")}
        </h2>
        <ul className="mt-1 space-y-1">
          {result.reversible.map((line) => (
            <li
              key={line.text}
              className={`text-sm ${line.tone === "warning" ? "text-warning" : "text-foreground"}`}
            >
              {lineText(line)}
            </li>
          ))}
        </ul>
      </section>

      <section
        className="rounded-xl border border-warning/30 bg-warning/10 p-4"
        aria-labelledby="irreversible-effects"
        aria-live="assertive"
        aria-atomic="true"
      >
        <h2 id="irreversible-effects" className="text-sm font-semibold text-warning">
          {t("preflight.irreversible.title")}
        </h2>
        <ul className="mt-1 space-y-1">
          {result.irreversible.map((line) => (
            <li
              key={line.text}
              className={`text-sm ${line.tone === "warning" ? "text-warning" : "text-foreground"}`}
            >
              {lineText(line)}
            </li>
          ))}
        </ul>
      </section>

      {result.blocking.map((line) => (
        <StatusMessage
          key={line.text}
          code={line.tone === "error" ? "reconciliation_required" : "metadata_limitation"}
          detail={lineText(line)}
        />
      ))}

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={input.acknowledgedSourceMutations}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        {result.acknowledgement
          ? input.sourceMutations > 0
            ? t("preflight.acknowledge.mutations")
            : t("preflight.acknowledge")
          : t("preflight.acknowledge")}
      </label>

      <Button
        disabled={!result.canExecute || !input.acknowledgedSourceMutations || busy}
        onClick={onExecute}
      >
        {busy ? t("preflight.running") : t("preflight.execute")}
      </Button>
    </section>
  );
}
