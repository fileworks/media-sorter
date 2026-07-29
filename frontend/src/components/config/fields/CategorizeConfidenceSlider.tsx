import { useI18n } from "@/i18n/I18nContext";

export function CategorizeConfidenceSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const { t } = useI18n();
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t("config.slider.moreSorted")}</span>
        <span className="font-mono text-foreground">{pct}%</span>
        <span className="text-muted-foreground">{t("config.slider.onlySure")}</span>
      </div>
      <input
        aria-label={t("config.folder.confident")}
        type="range"
        min={50}
        max={99}
        value={pct}
        onChange={(e) => onChange(Math.min(99, Math.max(50, Number(e.target.value))) / 100)}
        className="w-full accent-primary"
      />
      <p className="text-xs text-muted-foreground">{t("config.slider.uncategorized")}</p>
    </div>
  );
}
