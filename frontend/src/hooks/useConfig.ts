import { useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { Config, ConfigIssue } from "@/types/api";

/** Group issues by the config field they target (dropping field-less ones). */
function byField(issues: ConfigIssue[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.field) continue;
    const existing = map.get(issue.field);
    if (existing) existing.push(issue.message);
    else map.set(issue.field, [issue.message]);
  }
  return map;
}

const CONFIG_KEY = ["config"] as const;

export function useConfig() {
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
  const { mutate } = useMutation({
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

  const resetConfig = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
  }, [queryClient]);

  // Field-keyed view so a section/input can flag itself without re-scanning the
  // flat error list. Keyed off the stable react-query result so it only
  // recomputes when validation actually changes.
  const fieldErrors = useMemo(() => byField(validationResult?.errors ?? []), [validationResult]);

  return {
    config,
    isLoading,
    isValid: validationResult?.valid ?? false,
    validationErrors: validationResult?.errors ?? [],
    validationWarnings: validationResult?.warnings ?? [],
    fieldErrors,
    error,
    updateConfig,
    resetConfig,
  };
}
