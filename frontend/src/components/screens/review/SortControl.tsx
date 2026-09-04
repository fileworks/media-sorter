/** Shared sort control used by both review toolbars. */

import { Select, SelectItem } from "@/components/ui/select";
import { useI18n } from "@/i18n/I18nContext";
import { REVIEW_SORTS, type ReviewSort } from "@/lib/reviewSort";
import { cn } from "@/lib/utils";

export function SortControl({
  id,
  value,
  onChange,
  className,
}: {
  /** Distinct per instance: two labels pointing at one select is not a label. */
  id: string;
  value: ReviewSort;
  onChange: (sort: ReviewSort) => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex shrink-0 items-center gap-2 whitespace-nowrap text-3xs text-muted-foreground",
        className,
      )}
    >
      {t("review.sort.label")}
      <Select
        id={id}
        size="sm"
        value={value}
        onValueChange={(next) => onChange(next as ReviewSort)}
        className="min-w-[8.5rem]"
      >
        {REVIEW_SORTS.map((sort) => (
          <SelectItem key={sort} value={sort}>
            {t(`review.sort.${sort}`)}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}
