/**
 * The plan's recorded working, presented without reconstructing any decision.
 *
 * The path is the answer, so the path is what this draws: one line reading
 * `2025 / 07 — July / Pixel 9 Pro / 2025-07-14_IMG_4382.jpg`, with every part
 * of it a control. Hovering one says what put it there; choosing one opens the
 * single reason panel below, next to the setting that decided it.
 *
 * That replaces a stacked card per segment. Six cards said the same four
 * things six times and pushed everything under them off the dialog, on a
 * surface that is not the common case: most people open a file to look at it,
 * and only occasionally to ask why it is going where it is going. So the
 * explanation costs two lines until it is asked a question, and the supporting
 * evidence — the losing date candidates, the rules that did not win — stays
 * folded away behind one disclosure.
 */

import { Fragment, useEffect, useState } from "react";
import { FiChevronRight, FiSettings } from "react-icons/fi";

import { settingAnchorForDecision } from "@/components/config/groups";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { formatDate } from "@/lib/dateFormatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { cn } from "@/lib/utils";
import type { OutcomeProvenance } from "@/types/api";

interface DestinationExplanationProps {
  provenance: OutcomeProvenance;
  onOpenSetting: (anchorId: string) => void;
}

/** One labelled line of the folded evidence. Omitted entirely when empty. */
function EvidenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-3xs font-semibold uppercase tracking-[0.06em] text-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-xs text-muted-foreground">{children}</dd>
    </>
  );
}

function sameRule(
  left: { name: string; priority: number; saved_order: number },
  right: { name: string; priority: number; saved_order: number } | null,
) {
  return (
    right !== null &&
    left.name === right.name &&
    left.priority === right.priority &&
    left.saved_order === right.saved_order
  );
}

export function DestinationExplanation({ provenance, onOpenSetting }: DestinationExplanationProps) {
  const { t, locale } = useI18n();
  const unknown = t("review.detail.unknown");
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const routeMatches = provenance.rules.matched_routes ?? [];
  const losingRoutes = routeMatches.filter(
    (candidate) => !sameRule(candidate, provenance.rules.winning_route),
  );

  const segments = provenance.path;
  const [chosen, setChosen] = useState<number | null>(null);
  // A different file is a different path; a selection carried over from the
  // last one would point at a segment that is no longer there.
  useEffect(() => setChosen(null), [provenance]);
  const selected = chosen === null ? null : (segments[chosen] ?? null);
  const anchor = selected === null ? null : settingAnchorForDecision(selected.decision);

  return (
    <div data-testid="destination-explanation" className="space-y-2">
      <h3 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
        {t("review.detail.destinationWorking")}
      </h3>

      {segments.length === 0 ? (
        <p className="text-xs text-faint">{t("review.detail.noDestinationSegments")}</p>
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-xs"
            aria-label={t("review.detail.destinationSegments")}
          >
            {segments.map((part, index) => {
              const active = chosen === index;
              return (
                <Fragment key={`${index}:${part.decision}:${part.segment}`}>
                  {index > 0 && (
                    <span aria-hidden className="px-0.5 text-faint">
                      {/* A conversion is not another folder — it rewrites the
                          leaf it sits beside, so it is not read as a step down
                          the tree. */}
                      {part.decision === "conversion" ? "→" : "/"}
                    </span>
                  )}
                  <Tooltip
                    label={`${t(`review.detail.decision.${part.decision}`)} — ${part.detail}`}
                  >
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setChosen(active ? null : index)}
                      className={cn(
                        // 24px in both directions: a two-character segment
                        // like `07` is otherwise a target under the floor.
                        "min-h-6 min-w-6 max-w-full truncate rounded-control px-2 py-0.5 text-center transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-tint-primary font-semibold text-primary"
                          : "text-foreground hover:bg-muted",
                      )}
                    >
                      {part.segment}
                    </button>
                  </Tooltip>
                </Fragment>
              );
            })}
          </div>

          {/* The height is reserved whether or not a part is being read, so
              choosing one never shifts the disclosure below it. */}
          <div
            aria-live="polite"
            className="min-h-[3.5rem] rounded-panel border border-border bg-background px-3 py-2"
          >
            {selected === null ? (
              <p className="text-xs text-faint">{t("review.detail.pickSegment")}</p>
            ) : (
              <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="text-3xs font-semibold uppercase tracking-[0.06em] text-primary">
                    {t(`review.detail.decision.${selected.decision}`)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{selected.detail}</p>
                </div>
                {anchor === null ? (
                  <span className="shrink-0 text-3xs text-faint">
                    {t("review.detail.noSetting")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0"
                    onClick={() => onOpenSetting(anchor)}
                    aria-label={t("review.detail.openSettingFor", {
                      decision: t(`review.detail.decision.${selected.decision}`),
                    })}
                  >
                    <FiSettings className="h-3.5 w-3.5" aria-hidden />
                    {t("review.detail.openSetting")}
                  </Button>
                )}
              </div>
            )}
          </div>
          <p className="text-3xs text-faint">{t("review.detail.settingCost")}</p>
        </>
      )}

      <details className="group rounded-panel border border-border bg-muted/20">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-panel px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <FiChevronRight
            className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
            aria-hidden
          />
          {t("review.detail.evidence.show")}
        </summary>
        {/* One grid rather than five bordered panels: every line here is a
            label and a value, and drawing each pair inside its own box made a
            short list look like a long one. */}
        <dl className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-border px-3 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <EvidenceRow label={t("review.detail.evidence.date")}>
            <p>
              {provenance.date.resolved_date === null
                ? unknown
                : t("review.detail.dateWinner", {
                    date: formatDate(provenance.date.resolved_date, { locale }),
                    source: formatMetadataSource(provenance.date.winning_source ?? "none", t),
                  })}
            </p>
            {provenance.date.candidates.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {provenance.date.candidates.map((candidate, index) => (
                  <li
                    key={`${index}:${candidate.source}:${candidate.value ?? ""}`}
                    className="flex gap-2 text-3xs"
                  >
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        candidate.accepted ? "text-success" : "text-faint",
                      )}
                    >
                      {formatMetadataSource(candidate.source, t)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {candidate.value ?? unknown}
                      {!candidate.accepted && candidate.rejection_reason !== null && (
                        <>
                          {" — "}
                          {t(`review.detail.rejected.${candidate.rejection_reason}`)}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </EvidenceRow>

          <EvidenceRow label={t("review.detail.evidence.category")}>
            {!provenance.categorization.enabled
              ? t("review.detail.categoryDisabled")
              : provenance.categorization.passed
                ? t("review.detail.categoryPassed", {
                    label: provenance.categorization.label ?? unknown,
                    confidence:
                      provenance.categorization.confidence === null
                        ? unknown
                        : percent.format(provenance.categorization.confidence),
                    threshold:
                      provenance.categorization.threshold === null
                        ? unknown
                        : percent.format(provenance.categorization.threshold),
                  })
                : t("review.detail.categoryRejected", {
                    confidence:
                      provenance.categorization.confidence === null
                        ? unknown
                        : percent.format(provenance.categorization.confidence),
                    threshold:
                      provenance.categorization.threshold === null
                        ? unknown
                        : percent.format(provenance.categorization.threshold),
                  })}
          </EvidenceRow>

          <EvidenceRow label={t("review.detail.evidence.rules")}>
            {provenance.rules.winning_route === null ? (
              <p>{t("review.detail.noRouteRule")}</p>
            ) : (
              <p>
                {t("review.detail.routeWinner", {
                  name: provenance.rules.winning_route.name,
                  folder: provenance.rules.route_folder ?? unknown,
                })}
              </p>
            )}
            {losingRoutes.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-3xs">
                {losingRoutes.map((rule) => (
                  <li key={`${rule.saved_order}:${rule.name}`}>
                    {t("review.detail.routeLost", { name: rule.name, priority: rule.priority })}
                  </li>
                ))}
              </ul>
            )}
            {provenance.rules.matched_tags.length > 0 && (
              <p className="mt-1 text-3xs">
                {t("review.detail.tagRules", {
                  names: provenance.rules.matched_tags.map((rule) => rule.name).join(", "),
                })}
              </p>
            )}
          </EvidenceRow>

          <EvidenceRow label={t("review.detail.evidence.duplicate")}>
            <p>{t(`review.detail.duplicate.${provenance.duplicate.status}`)}</p>
            {provenance.duplicate.match_kind !== null && (
              <p className="text-3xs">
                {t("review.detail.duplicateKind", { kind: provenance.duplicate.match_kind })}
              </p>
            )}
            {provenance.duplicate.matched_path !== null && (
              <p className="break-all text-3xs">
                {t("review.detail.duplicateMatch", { path: provenance.duplicate.matched_path })}
              </p>
            )}
            {provenance.duplicate.perceptual_distance !== null && (
              <p className="text-3xs">
                {t("review.detail.duplicateDistance", {
                  distance: provenance.duplicate.perceptual_distance,
                })}
              </p>
            )}
          </EvidenceRow>

          {/* Only where the file actually belongs to one. A row reading "no
              media unit" on every ordinary photo is the reason this section
              read as noise. */}
          {provenance.unit !== null && (
            <EvidenceRow label={t("review.detail.evidence.unit")}>
              <p>{t("review.detail.mediaUnit", { role: provenance.unit.role })}</p>
              {provenance.unit.members.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-3xs">
                  {provenance.unit.members.map((member) => (
                    <li key={member} className="break-all">
                      {member}
                    </li>
                  ))}
                </ul>
              )}
            </EvidenceRow>
          )}
        </dl>
      </details>
    </div>
  );
}
