/** Preview a bulk rule without modifying manual decisions. */

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";

export interface RuleImpact {
  /** Sets with no binding decision yet. */
  open: number;
  /** Of those, the ones this rule can rank and would decide. */
  decides: number;
  /** Of those, the ones it cannot rank and will leave alone. */
  cannotRank: number;
  /** Decisions already made by hand, which the rule never touches. */
  keepsManual: number;
}

export function RuleImpactModal({
  open,
  ruleLabel,
  impact,
  onApply,
  onClose,
}: {
  open: boolean;
  ruleLabel: string;
  impact: RuleImpact;
  onApply: () => void;
  onClose: () => void;
}) {
  const { t, tCount } = useI18n();

  const rows: [string, number][] = [
    [t("review.ruleImpact.open"), impact.open],
    [t("review.ruleImpact.decides"), impact.decides],
    [t("review.ruleImpact.cannotRank"), impact.cannotRank],
    [t("review.ruleImpact.keepsManual"), impact.keepsManual],
  ];

  return (
    <Modal open={open} onClose={onClose} title={t("review.ruleImpact.title")} size="md">
      <ModalHeader />
      <ModalBody>
        <p className="text-xs text-muted-foreground">
          {t("review.ruleImpact.description", { rule: ruleLabel })}
        </p>
        <ul className="mt-2.5 overflow-hidden rounded-panel border border-border">
          {rows.map(([label, value]) => (
            <li
              key={label}
              className="flex items-center justify-between gap-3 border-b border-border px-2.5 py-2 text-xs last:border-b-0"
            >
              <span className="min-w-0 text-muted-foreground">{label}</span>
              <strong className="shrink-0 tabular-nums text-foreground">{value}</strong>
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-3xs leading-relaxed text-faint">{t("review.keepRule.scope")}</p>
      </ModalBody>
      <ModalFooter>
        <Button size="sm" variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={impact.decides === 0} onClick={onApply}>
          {tCount("review.ruleImpact.apply", impact.decides)}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
