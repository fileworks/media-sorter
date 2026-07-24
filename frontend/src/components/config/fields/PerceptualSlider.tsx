import { useI18n } from "@/i18n/I18nContext";

export function PerceptualSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const { t } = useI18n();
  const hint =
    value >= 98
      ? t("config.slider.pixel")
      : value >= 93
        ? t("config.slider.recompressed")
        : value >= 88
          ? t("config.slider.edited")
          : t("config.slider.risky");

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t("config.slider.lenient")}</span>
        <span className="font-mono text-foreground">{value}%</span>
        <span className="text-muted-foreground">{t("config.slider.strict")}</span>
      </div>
      <input
        type="range"
        min={85}
        max={100}
        value={value}
        onChange={(e) => onChange(Math.min(100, Math.max(85, Number(e.target.value))))}
        className="w-full accent-primary"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
