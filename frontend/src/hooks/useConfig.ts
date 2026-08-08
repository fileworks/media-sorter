import { useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { Config, ConfigIssue } from "@/types/api";
import { useI18n } from "@/i18n/I18nContext";

/** Group issues by the config field they target (dropping field-less ones). */
function byField(
  issues: ConfigIssue[],
  translate: (key: string, params?: Record<string, string | number>, fallback?: string) => string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.field) continue;
    const existing = map.get(issue.field);
    const message = translate(issue.message_key, issue.params, issue.message);
    if (existing) existing.push(message);
    else map.set(issue.field, [message]);
  }
  return map;
}

const CONFIG_KEY = ["config"] as const;

export function useConfig() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const {
    data: config,
    isLoading,
    error,
  } = useQuery({
    queryKey: CONFIG_KEY,
    queryFn: () => api.getConfig(),
  });

  const { data: validationResult } = useQuery({
    queryKey: ["config", "validate"],
    queryFn: () => api.validateConfig(),
    enabled: !!config,
  });

  // Destructure mutate so the useCallback dependency is the stable function
  // reference, not the mutation object (which changes on every render).
  const {
    mutate,
    error: saveError,
    isPending: isSaving,
    variables: lastSavePatch,
  } = useMutation({
    mutationFn: (patch: Partial<Config>) => api.saveConfig(patch),
    // Serialize saves under a shared scope so two quick edits (each a partial
    // merge on the backend) run in call order. Without this, retries can let an
    // earlier save's response land after a later one and clobber the newer
    // config in the cache (the retry race).
    scope: { id: "config-save" },
    // A transient backend hiccup shouldn't lose a settings change; retry with
    // exponential backoff before giving up.
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    onSuccess: (updated) => {
      queryClient.setQueryData(CONFIG_KEY, updated);
      void queryClient.invalidateQueries({ queryKey: ["config", "validate"] });
    },
  });

  const updateConfig = useCallback((patch: Partial<Config>) => mutate(patch), [mutate]);
  const retrySave = useCallback(() => {
    if (lastSavePatch) mutate(lastSavePatch);
  }, [lastSavePatch, mutate]);

  const resetConfig = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
  }, [queryClient]);

  // Field-keyed view so a section/input can flag itself without re-scanning the
  // flat error list. Keyed off the stable react-query result so it only
  // recomputes when validation actually changes.
  const fieldErrors = useMemo(
    () => byField(validationResult?.errors ?? [], t),
    [validationResult, t],
  );

  return {
    config,
    isLoading,
    // Deliberately no aggregate `valid` flag: the flow gates Sources and
    // Configure separately, and one boolean for the whole config is what let a
    // settings error present itself as a folder error. Route the errors through
    // `splitValidation` instead.
    validationErrors: validationResult?.errors ?? [],
    validationWarnings: validationResult?.warnings ?? [],
    fieldErrors,
    error,
    saveError,
    isSaving,
    updateConfig,
    retrySave,
    resetConfig,
  };
}
