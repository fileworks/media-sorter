import type { Config } from "@/types/api";

export const DEFAULT_AI_LABELS = [
  // Places & environments
  "beach",
  "mountain",
  "forest",
  "city",
  "landscape",
  "sunset",
  "sunrise",
  "sky",
  "snow",
  "water",
  "night",
  "indoor",
  "outdoor",
  // People
  "portrait",
  "selfie",
  "group photo",
  // Events & activities
  "wedding",
  "birthday",
  "party",
  "concert",
  "sport",
  "hiking",
  "camping",
  // Food & drink
  "food",
  "drink",
  // Animals
  "pet",
  "dog",
  "cat",
  "bird",
  "wildlife",
  "flower",
  // Vehicles
  "car",
  "boat",
  "airplane",
  // Urban
  "building",
  "street",
  // Travel
  "travel",
  "landmark",
  // Documents & screen
  "document",
  "screenshot",
  "receipt",
  "whiteboard",
  "text",
  // Art & media
  "artwork",
  "meme",
  "graph",
  "map",
];

export const DEFAULT_CATEGORIES = [
  "screenshots",
  "documents",
  "receipts",
  "food",
  "nature",
  "people",
  "pets",
  "travel",
  "events",
  "sports",
  "memes",
];

export const MAX_FILE_SIZE_INPUT = 1_000_000;

export const DISK_BYTES_OPTS = { maxUnit: "TB", nullPlaceholder: "0 B" } as const;

export const EXAMPLE_DATE = new Date(2024, 2, 15, 10, 30, 0);

export function clampFileSize(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(0, Math.round(n)), MAX_FILE_SIZE_INPUT);
}

export function clampMaxTags(raw: string): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(1, n), 50);
}

export function clampConfidence(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(Math.max(0, n), 1);
}

export function clampMargin(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.15;
  return Math.min(Math.max(0, n), 0.5);
}

export const SECTION_DEFAULTS = {
  essentials: {
    sort: true,
    sort_criteria: ["year"],
    copy_instead_of_move: false,
  },
  folders: {
    camera_subfolder_enabled: false,
    preserve_subfolders: false,
    categorize_enabled: false,
    categorize_categories: DEFAULT_CATEGORIES,
    categorize_confidence_threshold: 0.55,
    categorize_min_margin: 0.15,
  },
  duplicates: {
    remove_duplicates: true,
    duplicate_exact_enabled: true,
    duplicate_perceptual_enabled: true,
    duplicate_perceptual_threshold: 95,
  },
  rename: {
    rename: false,
    rename_pattern: "TYPE_YYYY-MM-DD",
  },
  conversion: {
    convert_images: false,
    image_format: "jpeg" as const,
    convert_videos: false,
    video_format: "mp4" as const,
  },
  filters: {
    recursive_scan: true,
    min_file_size_kb: null,
    max_file_size_mb: null,
    exclude_patterns: [
      "@eaDir",
      ".@__thumb",
      "@Recycle",
      "Thumbs.db",
      "desktop.ini",
      ".DS_Store",
      ".Spotlight-V100",
      "eaRecycle",
    ],
  },
  rules: {
    rules_enabled: true,
    rules: [],
  },
  ai: {
    ai_tagging_enabled: false,
    ai_tagging_provider: "local",
    ai_tagging_confidence_threshold: 0.5,
    ai_tagging_api_key: null,
    ai_tagging_api_secret: null,
    ai_tagging_endpoint: null,
    ai_tagging_max_tags: 10,
    ai_tagging_embed_in_files: true,
    ai_tagging_labels: DEFAULT_AI_LABELS,
  },
  other: {
    override_metadata: false,
    repair_enabled: true,
  },
} satisfies Record<string, Partial<Config>>;

export type SectionId = keyof typeof SECTION_DEFAULTS;

export function isSectionDirty(config: Config, section: SectionId): boolean {
  const defaults = SECTION_DEFAULTS[section] as Partial<Config>;
  return (Object.keys(defaults) as (keyof Config)[]).some(
    (key) => JSON.stringify(config[key]) !== JSON.stringify(defaults[key]),
  );
}

export interface SectionProps {
  config: Config;
  updateConfig: (patch: Partial<Config>) => void;
  /** Server validation errors keyed by config field → user-facing messages. */
  fieldErrors: ReadonlyMap<string, string[]>;
}
