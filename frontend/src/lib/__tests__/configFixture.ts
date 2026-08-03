/**
 * One complete `Config` for tests that render a real screen.
 *
 * The section defaults cover the flat fields; the nested profiles and the newer
 * scalar settings are spelled out because the screens read them directly and a
 * missing profile throws rather than degrading. Shared rather than copied so
 * that adding a `Config` field breaks one fixture, not five.
 */

import { SECTION_DEFAULTS } from "@/components/config/constants";
import type { Config } from "@/types/api";

export const TEST_CONFIG = {
  ...Object.assign({}, ...Object.values(SECTION_DEFAULTS)),
  source_directory: "",
  target_directory: "",
  duplicate_keeper_policy: "newest",
  image_quality: 90,
  video_quality: "medium",
  saved_recipes: [],
  ai_model_tier: "auto",
  ai_allow_gpu: true,
  library_profile: {
    schema_version: 1,
    profile_id: "test",
    name: "Test fixture",
    roots: [],
    transfer_mode: "copy",
    catalog: { mode: "application_data", relative_path: null },
    resources: { mode: "auto", memory_limit_mib: null, io_workers: null, cpu_workers: null },
  },
  preservation_profile: {
    schema_version: 1,
    profile_id: "default",
    name: "Organize only",
    mode: "organize_only",
    allow_embedded_metadata_edits: false,
    allow_repair: false,
    allow_conversion: false,
    allow_compression: false,
    preserve_filesystem_timestamps: true,
    derived_metadata: "report_only",
    authorization_origin: "default",
    acknowledged_at: null,
    requires_review: false,
  },
  optimization_profile: {
    schema_version: 1,
    profile_id: "optimization-disabled",
    name: "Optimization disabled",
    mode: "disabled",
    acknowledged_at: null,
    tool: null,
    tool_version: null,
    parameters: {},
    validation_contract: null,
    memory_limit_mib: 512,
    temporary_space_limit_bytes: null,
    retain_original: true,
  },
} as Config;
