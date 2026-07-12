import { useState, useCallback } from "react";
import { api } from "@/services/api";

export interface UseAiSuggestionsResult {
  suggestions: string[];
  loading: boolean;
  error: string | null;
  suggest: (n?: number) => Promise<void>;
  dismiss: (label: string) => void;
  clear: () => void;
}

export function useAiSuggestions(): UseAiSuggestionsResult {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggest = useCallback(async (n: number = 5) => {
    setLoading(true);
    setError(null);
    setSuggestions([]);
    try {
      const res = await api.suggestCategories(n);
      setSuggestions(res.suggestions);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Suggestions unavailable — ensure a source folder is set and local AI is enabled.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const dismiss = useCallback((label: string) => {
    setSuggestions((prev) => prev.filter((s) => s !== label));
  }, []);

  const clear = useCallback(() => {
    setSuggestions([]);
    setError(null);
  }, []);

  return { suggestions, loading, error, suggest, dismiss, clear };
}
