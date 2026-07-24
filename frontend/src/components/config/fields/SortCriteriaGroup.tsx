import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";

const OPTIONS = [
  { key: "year", value: ["year"] as string[] },
  { key: "yearMonth", value: ["year", "month"] as string[] },
  { key: "yearMonthDay", value: ["year", "month", "day"] as string[] },
];

export function SortCriteriaGroup({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const activeKey = value.includes("day")
    ? "yearMonthDay"
    : value.includes("month")
      ? "yearMonth"
      : "year";

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row">
      {OPTIONS.map((opt) => (
        <label
          key={opt.key}
          className={cn(
            "flex flex-1 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
            activeKey === opt.key
              ? "border-primary bg-primary/10 text-foreground"
              : "border-input bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
          )}
        >
          <input
            type="radio"
            name="sort-criteria"
            className="accent-primary"
            checked={activeKey === opt.key}
            onChange={() => onChange(opt.value)}
          />
          <span>{t(`config.date.${opt.key}`)}</span>
        </label>
      ))}
    </div>
  );
}
