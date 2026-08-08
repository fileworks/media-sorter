/** The plan's recorded working, presented without reconstructing any decision. */

import { FiSettings } from "react-icons/fi";

import { settingAnchorForDecision } from "@/components/config/groups";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { formatMetadataSource } from "@/lib/metadataSource";
import { cn } from "@/lib/utils";
import type { OutcomeProvenance } from "@/types/api";

interface DestinationExplanationProps {
  provenance: OutcomeProvenance;
  onOpenSetting: (anchorId: string) => void;
}

function EvidenceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-2.5 first:border-t-0 first:pt-0">
      <h4 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">{title}</h4>
      <div className="mt-1.5 text-xs text-muted-foreground">{children}</div>
    </section>
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

  return (
    <div data-testid="destination-explanation" className="space-y-3">
      <div>
        <h3 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
          {t("review.detail.destinationWorking")}
        </h3>
        <p className="mt-1 text-xs text-faint">{t("review.detail.settingCost")}</p>
      </div>

      {provenance.path.length === 0 ? (
        <p className="text-xs text-faint">{t("review.detail.noDestinationSegments")}</p>
      ) : (
        <ol className="space-y-1.5" aria-label={t("review.detail.destinationSegments")}>
          {provenance.path.map((part, index) => {
            const anchor = settingAnchorForDecision(part.decision);
            return (
              <li
                key={`${index}:${part.decision}:${part.segment}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="min-w-0 break-all text-xs font-semibold text-foreground">
                    {part.segment}
                  </code>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                    {t(`review.detail.decision.${part.decision}`)}
                  </span>
                  {anchor === null ? (
                    <span className="ml-auto text-3xs text-faint">
                      {t("review.detail.noSetting")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7"
                      onClick={() => onOpenSetting(anchor)}
                      aria-label={t("review.detail.openSettingFor", {
                        decision: t(`review.detail.decision.${part.decision}`),
                      })}
                    >
                      <FiSettings className="h-3.5 w-3.5" aria-hidden />
                      {t("review.detail.openSetting")}
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{part.detail}</p>
              </li>
            );
          })}
        </ol>
      )}

      <div className="space-y-2.5 rounded-md border border-border px-3 py-2.5">
        <EvidenceSection title={t("review.detail.evidence.date")}>
          <p>
            {provenance.date.resolved_date === null
              ? unknown
              : t("review.detail.dateWinner", {
                  date: provenance.date.resolved_date,
                  source: formatMetadataSource(provenance.date.winning_source ?? "none", t),
                })}
          </p>
          {provenance.date.candidates.length > 0 && (
            <ul className="mt-1 space-y-1">
              {provenance.date.candidates.map((candidate, index) => (
                <li
                  key={`${index}:${candidate.source}:${candidate.value ?? ""}`}
                  className="flex gap-2"
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
        </EvidenceSection>

        <EvidenceSection title={t("review.detail.evidence.category")}>
          {!provenance.categorization.enabled ? (
            <p>{t("review.detail.categoryDisabled")}</p>
          ) : (
            <p>
              {provenance.categorization.passed
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
            </p>
          )}
        </EvidenceSection>

        <EvidenceSection title={t("review.detail.evidence.rules")}>
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
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {losingRoutes.map((rule) => (
                <li key={`${rule.saved_order}:${rule.name}`}>
                  {t("review.detail.routeLost", { name: rule.name, priority: rule.priority })}
                </li>
              ))}
            </ul>
          )}
          {provenance.rules.matched_tags.length > 0 && (
            <p className="mt-1">
              {t("review.detail.tagRules", {
                names: provenance.rules.matched_tags.map((rule) => rule.name).join(", "),
              })}
            </p>
          )}
        </EvidenceSection>

        <EvidenceSection title={t("review.detail.evidence.duplicate")}>
          <p>{t(`review.detail.duplicate.${provenance.duplicate.status}`)}</p>
          {provenance.duplicate.match_kind !== null && (
            <p>{t("review.detail.duplicateKind", { kind: provenance.duplicate.match_kind })}</p>
          )}
          {provenance.duplicate.matched_path !== null && (
            <p className="break-all">
              {t("review.detail.duplicateMatch", { path: provenance.duplicate.matched_path })}
            </p>
          )}
          {provenance.duplicate.perceptual_distance !== null && (
            <p>
              {t("review.detail.duplicateDistance", {
                distance: provenance.duplicate.perceptual_distance,
              })}
            </p>
          )}
        </EvidenceSection>

        <EvidenceSection title={t("review.detail.evidence.unit")}>
          {provenance.unit === null ? (
            <p>{t("review.detail.noMediaUnit")}</p>
          ) : (
            <>
              <p>{t("review.detail.mediaUnit", { role: provenance.unit.role })}</p>
              {provenance.unit.members.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {provenance.unit.members.map((member) => (
                    <li key={member} className="break-all">
                      {member}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </EvidenceSection>
      </div>
    </div>
  );
}
