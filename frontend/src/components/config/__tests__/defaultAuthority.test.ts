import { describe, expect, it } from "vitest";

import constants from "@/components/config/constants.ts?raw";
import aiEngine from "@/components/config/fields/AiEngine.tsx?raw";
import clean from "@/components/config/groups/CleanGroup.tsx?raw";
import enrich from "@/components/config/groups/EnrichGroup.tsx?raw";
import sort from "@/components/config/groups/SortGroup.tsx?raw";

const CONFIG_UI = [aiEngine, clean, enrich, sort].join("\n");

const REQUIRED_FIELDS = [
  "ai_allow_gpu",
  "ai_model_tier",
  "ai_tagging_confidence_threshold",
  "ai_tagging_labels",
  "ai_tagging_max_tags",
  "camera_subfolder_enabled",
  "categorize_categories",
  "categorize_confidence_threshold",
  "categorize_enabled",
  "categorize_min_margin",
  "convert_images",
  "convert_videos",
  "duplicate_perceptual_threshold",
  "exclude_patterns",
  "image_format",
  "junk_filename_patterns",
  "junk_filter_enabled",
  "junk_min_file_size_kb",
  "junk_min_image_dimension",
  "repair_enabled",
  "sort_criteria",
  "video_format",
] as const;

describe("backend-owned configuration defaults", () => {
  it("keeps no concrete bundled vocabulary in the frontend", () => {
    expect(constants).not.toContain("DEFAULT_AI_LABELS");
    expect(constants).not.toContain("DEFAULT_CATEGORIES");
  });

  it.each(REQUIRED_FIELDS)("renders required %s without a frontend fallback", (field) => {
    expect(CONFIG_UI).not.toMatch(new RegExp(`config\\.${field}\\s*\\?\\?`));
  });
});
