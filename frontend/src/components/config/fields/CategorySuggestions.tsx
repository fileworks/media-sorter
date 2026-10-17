/**
 * Offer category names drawn from a sample of the user's own photos.
 *
 * Suggestions are one-click additions, never applied automatically: the local
 * model clusters up to 150 sampled images and names each cluster, and the user
 * decides which names become folders.
 */

import { useMutation } from "@tanstack/react-query";
import { FiLoader, FiPlus, FiZap } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { api } from "@/services/api";

interface CategorySuggestionsProps {
  categories: string[];
  /** False when no input folder is set: there is nothing to sample. */
  hasSource: boolean;
  onAdd: (category: string) => void;
}

export function CategorySuggestions({ categories, hasSource, onAdd }: CategorySuggestionsProps) {
  const { t } = useI18n();
  const suggest = useMutation({ mutationFn: () => api.suggestCategories(6) });
  const present = new Set(categories.map((category) => category.toLocaleLowerCase()));
  const offered = (suggest.data?.suggestions ?? []).filter(
    (suggestion) => !present.has(suggestion.toLocaleLowerCase()),
  );

  return (
    <div className="mt-3 space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => suggest.mutate()}
        disabled={!hasSource || suggest.isPending}
      >
        {suggest.isPending ? (
          <FiLoader className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <FiZap className="h-3.5 w-3.5" aria-hidden />
        )}
        {t("config.folder.suggest")}
      </Button>
      <p role="status" className="text-xs text-muted-foreground">
        {!hasSource
          ? t("config.folder.suggestNeedsSource")
          : suggest.isPending
            ? t("config.folder.suggestRunning")
            : suggest.isError
              ? null
              : suggest.isSuccess && offered.length === 0
                ? t("config.folder.suggestNone")
                : t("config.folder.suggestHelp")}
      </p>
      {suggest.isError && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(suggest.error, t("config.folder.suggestFailed")).message}
        </p>
      )}
      {offered.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t("config.folder.suggestions")}>
          {offered.map((suggestion) => (
            <li key={suggestion}>
              <Button
                type="button"
                size="sm"
                variant="suggest"
                onClick={() => onAdd(suggestion)}
                aria-label={t("config.folder.suggestAdd", { name: suggestion })}
              >
                <FiPlus className="h-3.5 w-3.5" aria-hidden />
                {suggestion}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
