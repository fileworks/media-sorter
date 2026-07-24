import { sanitizeCategory } from "@/lib/pathUtils";
import { useI18n } from "@/i18n/I18nContext";

export function CategoryTagsInput({
  categories,
  onChange,
  disabled = false,
}: {
  categories: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const add = (raw: string) => {
    const safe = sanitizeCategory(raw);
    if (!safe) return;
    if (categories.some((c) => c.toLowerCase() === safe.toLowerCase())) return;
    onChange([...categories, safe]);
  };
  const remove = (cat: string) => onChange(categories.filter((c) => c !== cat));

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {categories.map((cat) => (
          <span
            key={cat}
            className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {cat}
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(cat)}
              className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label={t("common.removeValue", { value: cat })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          disabled={disabled}
          placeholder={t("config.input.addCategory")}
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
        {t("config.input.categoryCount", {
          count: categories.length.toLocaleString(locale),
        })}
      </p>
    </div>
  );
}
