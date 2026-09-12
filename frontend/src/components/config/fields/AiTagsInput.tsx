import { useI18n } from "@/i18n/I18nContext";
import { Input } from "@/components/ui/input";

export function AiTagsInput({
  labels,
  onCommit,
  disabled = false,
}: {
  labels: string[];
  onCommit: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t, tCount, locale } = useI18n();
  const add = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (labels.some((l) => l.toLowerCase() === tag.toLowerCase())) return;
    onCommit([...labels, tag]);
  };
  const remove = (tag: string) => onCommit(labels.filter((l) => l !== tag));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {labels.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-secondary px-3 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {tag}
            {/* A chip's inline remove target, not a standalone form action. */}
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(tag)}
              className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
              aria-label={t("common.removeValue", { value: tag })}
            >
              ×
            </button>
          </span>
        ))}
        <Input
          type="text"
          disabled={disabled}
          placeholder={t("config.input.addLabel")}
          aria-label={t("config.input.addLabel")}
          className="min-w-[8rem] flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              const input = e.currentTarget;
              add(input.value);
              input.value = "";
            }
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {tCount("config.input.labelCount", labels.length, {
          count: labels.length.toLocaleString(locale),
        })}
      </p>
    </div>
  );
}
