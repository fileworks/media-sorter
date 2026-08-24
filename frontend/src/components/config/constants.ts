import type { SampleFile } from "@/lib/configSummary";
import type { Config } from "@/types/api";

export const MAX_FILE_SIZE_INPUT = 1_000_000;

export const DISK_BYTES_OPTS = { maxUnit: "TB", nullPlaceholder: "0 B" } as const;

export const EXAMPLE_DATE = new Date(2024, 2, 15, 10, 30, 0);

export function clampFileSize(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(0, Math.round(n)), MAX_FILE_SIZE_INPUT);
}

export function clampMaxTags(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, n), 50);
}

export function clampConfidence(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(0, n), 1);
}

export function clampMargin(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(0, n), 0.5);
}

/*
 * Field ownership is presentation metadata only. Concrete values are fetched
 * from the backend's /api/config/defaults endpoint.
 */
export const SECTION_FIELDS = {
  essentials: [
    "language",
    "source_directory",
    "target_directory",
    "run_mode",
    "sort",
    "sort_criteria",
    "copy_instead_of_move",
    "companion_handling",
  ],
  folders: [
    "camera_subfolder_enabled",
    "preserve_subfolders",
    "categorize_enabled",
    "categorize_categories",
    "categorize_categories_provenance",
    "categorize_confidence_threshold",
    "categorize_min_margin",
  ],
  duplicates: [
    "remove_duplicates",
    "duplicate_exact_enabled",
    "duplicate_perceptual_enabled",
    "duplicate_perceptual_threshold",
    "duplicate_keeper_policy",
    "burst_detection_enabled",
    "burst_time_window_seconds",
    "burst_perceptual_distance",
    "burst_require_camera_identity",
  ],
  rename: ["rename", "rename_pattern"],
  conversion: [
    "convert_images",
    "image_format",
    "image_quality",
    "convert_videos",
    "video_format",
    "video_quality",
  ],
  filters: [
    "recursive_scan",
    "max_recursion_depth",
    "min_file_size_kb",
    "max_file_size_mb",
    "exclude_patterns",
    "junk_filter_enabled",
    "junk_min_file_size_kb",
    "junk_min_image_dimension",
    "junk_filename_patterns",
  ],
  rules: ["rules_enabled", "rule_set"],
  ai: [
    "ai_tagging_enabled",
    "ai_tagging_confidence_threshold",
    "ai_tagging_max_tags",
    "embed_tags_in_files",
    "ai_tagging_labels",
    "ai_tagging_labels_provenance",
    "ai_model_tier",
    "ai_allow_gpu",
  ],
  other: [
    "override_metadata",
    "repair_enabled",
    "update_check_enabled",
    "thumbnail_cache_enabled",
    "thumbnail_cache_budget_bytes",
    "index_workers",
  ],
} as const satisfies Record<string, readonly (keyof Config)[]>;

export type SectionId = keyof typeof SECTION_FIELDS;

export interface SectionProps {
  config: Config;
  updateConfig: (patch: Partial<Config>) => void;
  /** Server validation errors keyed by config field → user-facing messages. */
  fieldErrors: ReadonlyMap<string, string[]>;
  /**
   * Files from the last dry run, so the folder and rename previews are drawn
   * with the user's own filenames. Falls back to the invented pair before a run
   * has produced any.
   */
  samples: readonly SampleFile[];
  /** Reset this group to the active recipe/default baseline. */
  onReset?: () => void;
}
