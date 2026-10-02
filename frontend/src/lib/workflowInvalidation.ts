import type { Config } from "@/types/api";

/** The oldest workflow artifact made stale by a configuration patch. */
export type WorkflowInvalidation = "none" | "preview" | "scan";

const PRESENTATION_ONLY = new Set<keyof Config>([
  "saved_recipes",
  "thumbnail_cache_enabled",
  "thumbnail_cache_budget_bytes",
  "update_check_enabled",
]);

// Analysis describes traversal, source scope, media-unit grouping and the
// copy/move disk-space estimate. Other operational settings can reuse it.
const SCAN_AFFECTING = new Set<keyof Config>([
  "source_directory",
  "target_directory",
  "library_profile",
  "recursive_scan",
  "max_recursion_depth",
  "exclude_patterns",
  "min_file_size_kb",
  "max_file_size_mb",
  "companion_handling",
  "copy_instead_of_move",
]);

export function invalidationForConfigPatch(patch: Partial<Config>): WorkflowInvalidation {
  const keys = Object.keys(patch) as (keyof Config)[];
  if (keys.some((key) => SCAN_AFFECTING.has(key))) return "scan";
  if (keys.some((key) => !PRESENTATION_ONLY.has(key))) return "preview";
  return "none";
}
