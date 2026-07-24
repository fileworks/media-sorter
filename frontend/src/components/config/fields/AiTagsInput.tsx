import { useI18n } from "@/i18n/I18nContext";

export function AiTagsInput({
  labels,
  onCommit,
  disabled = false,
}: {
  labels: string[];
  onCommit: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (labels.some((l) => l.toLowerCase() === tag)) return;
    onCommit([...labels, tag]);
  };
  const remove = (tag: string) => onCommit(labels.filter((l) => l !== tag));

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {labels.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {tag}
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(tag)}
              className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label={t("common.removeValue", { value: tag })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          disabled={disabled}
          placeholder={t("config.input.addLabel")}
          className="h-6 rounded-full border border-input bg-transparent px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              const input = e.target as HTMLInputElement;
              add(input.value);
              input.value = "";
            }
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("config.input.labelCount", { count: labels.length.toLocaleString(locale) })}
      </p>
    </div>
  );
}
