import { useI18n } from "@/i18n/I18nContext";
import { Input } from "@/components/ui/input";

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
    <div className="flex flex-wrap gap-2">
      {patterns.map((pattern) => (
        <span
          key={pattern}
          className="flex items-center gap-1 rounded-full bg-secondary px-3 py-0.5 text-xs font-medium text-secondary-foreground"
        >
          <code>{pattern}</code>
          {/* A chip's inline remove target, not a standalone form action. */}
          <button
            type="button"
            onClick={() => onRemove(pattern)}
            className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("common.removeValue", { value: pattern })}
          >
            ×
          </button>
        </span>
      ))}
      <Input
        type="text"
        placeholder={t("config.input.addPattern")}
        aria-label={t("config.input.addPattern")}
        className="min-w-[8rem] flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const input = e.currentTarget;
            const val = input.value.trim();
            if (val) onAdd(val);
            input.value = "";
          }
        }}
      />
    </div>
  );
}
