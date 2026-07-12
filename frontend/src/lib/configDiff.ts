/**
 * Compute which config settings deviate from the factory defaults.
 *
 * Detection is driven by the backend's own defaults (GET /api/config/defaults),
 * so it can never silently drift from the real Config dataclass the way a
 * hand-maintained client-side mirror would.
 */
import type { Config } from "@/types/api";

export interface ConfigDiffEntry {
  key: keyof Config;
  /** Human-readable field name, e.g. "Duplicate action". */
  label: string;
  /** The current value, formatted for display. */
  current: string;
  /** The default value, formatted for display. */
  default: string;
}

// Friendly labels where the auto-humanized key reads poorly. Everything else is
// derived from the key, so new fields get a sensible label for free.
const LABEL_OVERRIDES: Partial<Record<keyof Config, string>> = {
  sort_criteria: "Date folder levels",
  copy_instead_of_move: "Copy instead of move",
  duplicate_exact_enabled: "Exact-match duplicates",
  duplicate_perceptual_enabled: "Visual-similarity duplicates",
  duplicate_perceptual_threshold: "Similarity threshold",
  preserve_subfolders: "Preserve source subfolders",
  camera_subfolder_enabled: "Group by camera model",
  categorize_enabled: "Smart Categorization",
  categorize_categories: "Categories",
  categorize_confidence_threshold: "Categorization confidence",
  categorize_min_margin: "Categorization margin",
  recursive_scan: "Scan subfolders",
  max_recursion_depth: "Max scan depth",
  min_file_size_kb: "Min file size (KB)",
  max_file_size_mb: "Max file size (MB)",
  exclude_patterns: "Excluded patterns",
  rules_enabled: "Tagging rules",
  rename_pattern: "Rename pattern",
  override_metadata: "Override existing metadata",
  repair_enabled: "Repair corrupted files",
  update_check_enabled: "Check for updates",
  exif_sanity_check_enabled: "EXIF sanity check",
  ai_tagging_enabled: "AI content tagging",
  ai_tagging_provider: "AI provider",
  ai_tagging_confidence_threshold: "Tag confidence",
  ai_tagging_max_tags: "Max tags per file",
  ai_tagging_embed_in_files: "Embed tags in files",
  ai_tagging_labels: "Tag labels",
  ai_model_tier: "AI model tier",
  ai_allow_gpu: "Use GPU for AI",
};

const ACRONYMS: Record<string, string> = { ai: "AI", gpu: "GPU", exif: "EXIF", kb: "KB", mb: "MB" };

export function humanizeConfigKey(key: string): string {
  return key
    .split("_")
    .map((w) => ACRONYMS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function configFieldLabel(key: keyof Config): string {
  return LABEL_OVERRIDES[key] ?? humanizeConfigKey(key);
}

/** Format a config value compactly for the "current ← default" comparison. */
export function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    if (value.length <= 3) return value.join(", ");
    return `${value.length} items`;
  }
  return String(value);
}

/** Stable JSON for order-insensitive comparison would be overkill here — config
 * arrays are order-significant (sort_criteria) so a direct stringify is correct. */
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys whose live value differs from the default. */
export function changedKeys(config: Config, defaults: Partial<Config>): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(defaults) as (keyof Config)[]) {
    if (!eq(config[key], defaults[key])) out.add(key);
  }
  return out;
}

/** Full, display-ready list of deviations, sorted by label. */
export function diffConfig(config: Config, defaults: Partial<Config>): ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  for (const key of Object.keys(defaults) as (keyof Config)[]) {
    if (eq(config[key], defaults[key])) continue;
    entries.push({
      key,
      label: configFieldLabel(key),
      current: formatConfigValue(config[key]),
      default: formatConfigValue(defaults[key]),
    });
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}
