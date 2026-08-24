import { useI18n } from "@/i18n/I18nContext";
import { companionRoleLabel, companionStatusLabel, plannedStatusLabel } from "@/lib/evidenceLabels";
import { getBasename } from "@/lib/pathUtils";
import type { PreviewItem } from "@/types/api";

const DISPLAY_LIMIT = 50;

export function CompanionEvidencePanel({
  items,
  compact = false,
}: {
  items: readonly PreviewItem[];
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const units = items
    .filter(
      (item) =>
        // `!= null` on purpose: JSON carries an absent unit as `null` as often
        // as it omits the key, and `null !== undefined` is true — so a strict
        // check listed every file that belongs to no unit at all, then rendered
        // its membership as "Primary in unit null".
        item.unit_id != null ||
        (item.companions?.length ?? 0) > 0 ||
        (item.unit_warnings?.length ?? 0) > 0,
    )
    .sort((left, right) => left.source.localeCompare(right.source));
  if (units.length === 0) return null;
  const visible = units.slice(0, DISPLAY_LIMIT);

  return (
    <details className="overflow-hidden rounded-xl border border-border bg-card" open={!compact}>
      <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {t("companionEvidence.summary", { count: units.length.toLocaleString(locale) })}
      </summary>
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {visible.map((item) => (
            <li
              key={`${item.unit_id ?? "unknown"}:${item.source}`}
              className="space-y-1 px-3 py-2.5"
            >
              <p className="break-all text-xs font-semibold text-foreground">{item.source}</p>
              <p className="text-3xs text-muted-foreground">
                {item.unit_id == null
                  ? t("companionEvidence.membership.unknown")
                  : item.unit_primary === true
                    ? t("companionEvidence.membership.primary", { id: item.unit_id })
                    : item.unit_primary === false
                      ? t("companionEvidence.membership.member", { id: item.unit_id })
                      : t("companionEvidence.membership.roleUnknown", { id: item.unit_id })}
              </p>
              <p className="break-all text-3xs text-muted-foreground">
                {t("companionEvidence.primaryOutcome", {
                  status: plannedStatusLabel(item.status, t),
                  destination: item.destination ?? t("review.destination.none"),
                })}
              </p>
              {(item.companions ?? []).map((companion) => (
                <p
                  key={`${companion.role}:${companion.source}`}
                  className="break-all text-3xs text-muted-foreground"
                >
                  {t("companionEvidence.companion", {
                    file: getBasename(companion.source),
                    role: companionRoleLabel(companion.role, t),
                    status: companionStatusLabel(companion.status, t),
                    destination: companion.destination ?? t("review.destination.none"),
                    warning: companion.warning ?? t("companionEvidence.noWarning"),
                  })}
                </p>
              ))}
              {(item.unit_warnings ?? []).map((warning) => (
                <p key={warning} className="text-3xs text-warning">
                  {t("companionEvidence.warning", { warning })}
                </p>
              ))}
            </li>
          ))}
        </ul>
        {units.length > visible.length && (
          <p className="border-t border-border px-3 py-2 text-3xs text-muted-foreground">
            {t("companionEvidence.truncated", {
              shown: visible.length,
              total: units.length,
            })}
          </p>
        )}
      </div>
    </details>
  );
}
