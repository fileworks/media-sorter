import { useI18n } from "@/i18n/I18nContext";

export function ExcludePatternTags({
  patterns,
  onAdd,
  onRemove,
}: {
  patterns: string[];
  onAdd: (p: string) => void;
  onRemove: (p: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5">
      {patterns.map((pattern) => (
        <span
          key={pattern}
          className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
        >
          <code>{pattern}</code>
          <button
            type="button"
            onClick={() => onRemove(pattern)}
            className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("common.removeValue", { value: pattern })}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        placeholder={t("config.input.addPattern")}
        className="h-7 min-w-[8rem] rounded-full border border-input bg-background px-3 text-xs text-foreground transition-colors placeholder:text-faint hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const input = e.target as HTMLInputElement;
            const val = input.value.trim();
            if (val) onAdd(val);
            input.value = "";
          }
        }}
      />
    </div>
  );
}
