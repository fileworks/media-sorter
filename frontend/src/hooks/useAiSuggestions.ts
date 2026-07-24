import { useState, useCallback } from "react";
import { api } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";

export interface UseAiSuggestionsResult {
  suggestions: string[];
  loading: boolean;
  error: string | null;
  suggest: (n?: number) => Promise<void>;
  dismiss: (label: string) => void;
  clear: () => void;
}

export function useAiSuggestions(): UseAiSuggestionsResult {
  const { t } = useI18n();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggest = useCallback(
    async (n: number = 5) => {
      setLoading(true);
      setError(null);
      setSuggestions([]);
      try {
        const res = await api.suggestCategories(n);
        setSuggestions(res.suggestions);
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t("config.folder.suggestionsUnavailable");
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const dismiss = useCallback((label: string) => {
    setSuggestions((prev) => prev.filter((s) => s !== label));
  }, []);

  const clear = useCallback(() => {
    setSuggestions([]);
    setError(null);
  }, []);

  return { suggestions, loading, error, suggest, dismiss, clear };
}
