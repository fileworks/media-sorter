import { useI18n } from "@/i18n/I18nContext";

export function ResetButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
    >
      {t("common.resetSection")}
    </button>
  );
}
