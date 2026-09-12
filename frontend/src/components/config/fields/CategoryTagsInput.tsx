import { sanitizeCategory } from "@/lib/pathUtils";
import { useI18n } from "@/i18n/I18nContext";
import { Input } from "@/components/ui/input";

export function CategoryTagsInput({
  categories,
  onChange,
  disabled = false,
}: {
  categories: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t, tCount, locale } = useI18n();
  const add = (raw: string) => {
    const safe = sanitizeCategory(raw);
    if (!safe) return;
    if (categories.some((c) => c.toLowerCase() === safe.toLowerCase())) return;
    onChange([...categories, safe]);
  };
  const remove = (cat: string) => onChange(categories.filter((c) => c !== cat));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <span
            key={cat}
            className="flex items-center gap-1 rounded-full bg-secondary px-3 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {cat}
            {/* A chip's inline remove target, not a standalone form action. */}
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(cat)}
              className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
              aria-label={t("common.removeValue", { value: cat })}
            >
              ×
            </button>
          </span>
        ))}
        <Input
          type="text"
          disabled={disabled}
          placeholder={t("config.input.addCategory")}
          aria-label={t("config.input.addCategory")}
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
        {tCount("config.input.categoryCount", categories.length, {
          count: categories.length.toLocaleString(locale),
        })}
      </p>
    </div>
  );
}
