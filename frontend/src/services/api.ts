/**
 * Type-safe HTTP client for the MediaSorter FastAPI backend.
 *
 * Port is resolved at runtime from Tauri state so there are no hardcoded values.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { invoke } from "@tauri-apps/api/tauri";
import type { RecoveryOperation } from "@/lib/startupRecovery";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Config {
  language: "en" | "de";
  source_directory: string;
  target_directory: string;
  library_profile: LibraryProfile;
  preservation_profile: PreservationProfile;
  optimization_profile: OptimizationProfile;
  run_mode: RunMode;
  sort: boolean;
  sort_criteria: string[];
  recursive_scan: boolean;
  max_recursion_depth: number | null;
  preserve_subfolders: boolean;
  override_metadata: boolean;
  copy_instead_of_move: boolean;
  companion_handling: "keep_with_primary" | "leave_in_place" | "ignore";
  thumbnail_cache_enabled: boolean;
  thumbnail_cache_budget_bytes: number;
  rename: boolean;
  rename_pattern: string;
  remove_duplicates: boolean;
  duplicate_exact_enabled: boolean;
  duplicate_perceptual_enabled: boolean;
  duplicate_perceptual_threshold: number;
  /** Default keeper policy — a starting point Review may override per group. */
  duplicate_keeper_policy: KeeperPolicyId;
  burst_detection_enabled: boolean;
  burst_time_window_seconds: number;
  burst_perceptual_distance: number;
  burst_require_camera_identity: boolean;
  dedup_index_path: string | null;
  // Junk / thumbnail filter → _junk/ (never deletes).
  junk_filter_enabled: boolean;
  junk_min_file_size_kb: number;
  junk_min_image_dimension: number;
  junk_filename_patterns: string[];
  convert_videos: boolean;
  video_format: "mp4" | "mkv" | "mov" | "webm" | "avi";
  /** Re-encode quality for video conversion; mapped to a CRF by the backend. */
  video_quality: "low" | "medium" | "high";
  convert_images: boolean;
  image_format: "jpeg" | "png" | "webp" | "tiff";
  /** Encoder quality for lossy image formats. Ignored by PNG and TIFF. */
  image_quality: number;
  repair_enabled: boolean;
  rules_enabled: boolean;
  rule_set: RuleSet;
  ai_tagging_enabled: boolean;
  ai_tagging_provider: "local" | "azure_vision" | "imagga" | "google_cloud_vision";
  ai_tagging_confidence_threshold: number;
  ai_tagging_api_key: string | null;
  ai_tagging_api_secret: string | null;
  ai_tagging_endpoint: string | null;
  ai_tagging_max_tags: number;
  embed_tags_in_files: boolean;
  ai_tagging_labels: string[];
  ai_tagging_labels_provenance: "bundled" | "custom";
  // Smart Categorization — independent of ai_tagging_*: routes each file into a
  // user-named topic folder under the date hierarchy (…/Y/M/D/<category>/).
  categorize_enabled: boolean;
  categorize_categories: string[];
  categorize_categories_provenance: "bundled" | "custom";
  categorize_confidence_threshold: number;
  categorize_min_margin: number;
  exclude_patterns: string[];
  min_file_size_kb: number | null;
  max_file_size_mb: number | null;
  camera_subfolder_enabled: boolean;
  exif_sanity_check_enabled: boolean;
  update_check_enabled: boolean;
  // Local AI engine. `ai_model_tier` selects the encoder ("auto" lets the
  // hardware probe decide); `ai_allow_gpu` permits accelerator execution
  // providers (CoreML / CUDA / DirectML) for the local encoder.
  ai_model_tier: AiModelTier;
  ai_allow_gpu: boolean;
  /** The user's own named starting points, most recently saved first. */
  saved_recipes: SavedRecipe[];
}

/**
 * The slice of a configuration a recipe restores.
 *
 * Deliberately not the whole config: folders, credentials, vocabularies and
 * resource preferences are excluded so a recipe stays reusable across
 * libraries. Mirrors `backend/app/core/recipes.py`.
 */
export interface RecipeSettings {
  run_mode: RunMode;
  sort: boolean;
  sort_criteria: string[];
  recursive_scan: boolean;
  max_recursion_depth: number | null;
  preserve_subfolders: boolean;
  override_metadata?: boolean;
  copy_instead_of_move: boolean;
  companion_handling: Config["companion_handling"];
  rename: boolean;
  rename_pattern: string;
  remove_duplicates: boolean;
  duplicate_exact_enabled: boolean;
  duplicate_perceptual_enabled: boolean;
  duplicate_perceptual_threshold: number;
  duplicate_keeper_policy: KeeperPolicyId;
  burst_detection_enabled: boolean;
  burst_time_window_seconds: number;
  burst_perceptual_distance: number;
  burst_require_camera_identity: boolean;
  junk_filter_enabled: boolean;
  junk_min_file_size_kb: number;
  junk_min_image_dimension: number;
  junk_filename_patterns: string[];
  categorize_enabled: boolean;
  categorize_confidence_threshold: number;
  categorize_min_margin: number;
  convert_images: boolean;
  image_format: Config["image_format"];
  image_quality: number;
  convert_videos: boolean;
  video_format: Config["video_format"];
  video_quality: Config["video_quality"];
  repair_enabled: boolean;
  rules_enabled: boolean;
  ai_tagging_enabled: boolean;
  ai_tagging_confidence_threshold: number;
  ai_tagging_max_tags: number;
  embed_tags_in_files: boolean;
  exclude_patterns: string[];
  min_file_size_kb: number | null;
  max_file_size_mb: number | null;
  camera_subfolder_enabled: boolean;
  exif_sanity_check_enabled: boolean;
  ai_model_tier: AiModelTier;
}

export interface SavedRecipe {
  schema_version: 1;
  recipe_id: string;
  name: string;
  created_at: string;
  settings: RecipeSettings;
}

export type LibraryRootRole = "input" | "reference" | "destination";
export type TransferMode = "copy" | "move";

/**
 * How a duplicate group picks its keeper. Mirrors the backend's
 * `KeeperPolicyId`. Not every member is selectable: `protected_reference` is
 * automatic and always wins, and `preferred_root` depends on a root order the
 * interface no longer lets anyone set.
 */
/**
 * One duplicate set's decision, as the run receives it.
 *
 * Both halves are needed. `keep` alone cannot express the change, because
 * promoting a copy also demotes whichever copy the plan was going to place —
 * two actions, not one.
 */
export interface ReviewedSet {
  keep: string;
  demote: string[];
  /** Every member is independent; duplicate detection must not collapse them. */
  keep_all?: boolean;
}

export type KeeperPolicyId =
  | "best_quality"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest"
  | "highest_resolution"
  | "longest_filename"
  | "shortest_filename"
  | "preferred_root"
  | "protected_reference"
  | "manual";

/**
 * The keep rules a person may choose, in Configure as the default or in Review
 * as a per-run override. Mirrors the backend's `SELECTABLE_KEEPER_POLICIES`;
 * exported from here alone so the two surfaces cannot offer different sets.
 */
export const SELECTABLE_KEEPER_POLICIES = [
  "best_quality",
  "newest",
  "oldest",
  "largest",
  "smallest",
  "highest_resolution",
  "longest_filename",
  "shortest_filename",
  "manual",
] as const satisfies readonly KeeperPolicyId[];

/**
 * What a run is for.
 *
 * `organize` places every file into the destination structure. In
 * `deduplicate_only` nothing but duplicates and junk moves: the input tree is
 * left exactly as it was found, and the destination is used only for the review
 * folders.
 */
export type RunMode = "organize" | "deduplicate_only";

export interface RootIdentity {
  schema_version: 1;
  confidence: "high" | "medium" | "path_only" | "unresolved";
  canonical_path: string;
  volume_id: string | null;
  filesystem_id: string | null;
  root_file_id: string | null;
  platform: string | null;
  observed_at: string;
}

export interface LibraryRoot {
  root_id: string;
  role: LibraryRootRole;
  path: string;
  display_name: string | null;
  priority: number;
  exclusions: string[];
  identity: RootIdentity | null;
}

export interface CatalogPlacement {
  mode: "application_data" | "portable";
  relative_path: string | null;
}

export interface ResourcePreferences {
  mode: "auto" | "conservative" | "custom";
  memory_limit_mib: number | null;
  io_workers: number | null;
  cpu_workers: number | null;
}

export interface LibraryProfile {
  schema_version: 1;
  profile_id: string;
  name: string;
  roots: LibraryRoot[];
  transfer_mode: TransferMode;
  catalog: CatalogPlacement;
  resources: ResourcePreferences;
}

export interface PreservationProfile {
  schema_version: 1;
  profile_id: string;
  name: string;
  mode: "organize_only" | "explicit_mutation";
  allow_embedded_metadata_edits: boolean;
  allow_repair: boolean;
  allow_conversion: boolean;
  allow_compression: boolean;
  preserve_filesystem_timestamps: boolean;
  derived_metadata: "report_only" | "sidecar_and_report";
  authorization_origin: "default" | "migration" | "saved_profile" | "run_override";
  acknowledged_at: string | null;
  requires_review: boolean;
}

export interface OptimizationProfile {
  schema_version: 1;
  profile_id: string;
  name: string;
  mode: "disabled" | "lossless" | "visually_lossless";
  acknowledged_at: string | null;
  tool: string | null;
  tool_version: string | null;
  parameters: Record<string, unknown>;
  validation_contract: string | null;
  memory_limit_mib: number;
  temporary_space_limit_bytes: number | null;
  retain_original: boolean;
}

/** One representative encode the user may open beside its original. */
export interface SampleEncode {
  source_path: string;
  candidate_path: string | null;
  source_bytes: number;
  candidate_bytes: number;
  size_reduction_ratio: number;
  sampling_scope: string;
  passed: boolean | null;
  measurements: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  warnings: string[];
  comparable: boolean;
}

export interface ItemProjection {
  path: string;
  current_bytes: number;
  projected_low_bytes: number | null;
  projected_high_bytes: number | null;
  estimated_saving_bytes: number | null;
  confidence: "measured" | "sampled" | "estimated" | "unknown";
  estimate_only: boolean;
  output_container: string;
  output_codec: string;
  quality_setting: string;
  validation_method: string;
  compatibility_warnings: string[];
  temporary_space_bytes: number;
  quarantine_space_bytes: number;
  recommendation: "optimize" | "skip" | "blocked";
  reason: string;
  sample_source_path: string | null;
}

/** Where the index lives, what it costs, and how fresh each root is. */
export interface CatalogFreshness {
  root_id: string;
  state: "fresh" | "stale" | "unknown" | "rebuilding";
  generation: number | null;
  last_complete_scan_at: string | null;
  issue_count: number;
}

export interface CatalogDiagnostics {
  path: string;
  schema_version: number;
  size_bytes: number;
  soft_limit_bytes: number;
  over_soft_limit: boolean;
  mode: string;
  roots: number;
  files: number;
  hashed_files: number;
  missing_files: number;
  generations: number;
  open_generations: number;
  freshness: CatalogFreshness[];
}

import type {
  BulkImpact as ReviewBulkImpact,
  DuplicateGroup as ReviewGroup,
  GroupKind,
  GroupPlan as ReviewGroupPlan,
} from "@/lib/reviewWorkbench";

export type { GroupKind, ReviewGroup, ReviewGroupPlan };
export type BulkImpactResponse = ReviewBulkImpact;

export interface SimilarRulePreview {
  groups_considered: number;
  groups_affected: number;
  members_quarantined: number;
  quarantine_only: boolean;
  proposals: { group_id: string; applies: boolean; reason: string; members: number }[];
}

export interface ValidationFinding {
  finding_id: string;
  category: string;
  severity: "info" | "warning" | "error";
  state: "failed" | "passed" | "disabled" | "not_evaluated" | "unknown";
  root_id: string | null;
  relative_path: string | null;
  current_path: string | null;
  expected_path: string | null;
  evidence: string;
  confidence: "high" | "medium" | "low" | "unknown";
  rule_version: string;
  catalog_generation: number;
  actionable: boolean;
}

export interface ValidationReport {
  report_id: string;
  profile_id: string;
  catalog_generation: number;
  started_at: string;
  finished_at: string;
  findings: ValidationFinding[];
  unreachable_scopes: string[];
  disabled_categories: string[];
}

/** One row of a catalog-backed list — only what a row needs to draw. */
export interface CatalogViewRow {
  file_id: number;
  root_id: string;
  role: string;
  relative_path: string;
  size_bytes: number;
  mtime_ns: number;
  sha256: string | null;
}

export interface CatalogViewPage {
  rows: CatalogViewRow[];
  next_cursor: string | null;
  generation: number;
  total_rows: number;
  total_bytes: number;
}

export type AiModelTier = "auto" | "off" | "lite" | "standard" | "max";

/**
 * AI-relevant hardware capability, from GET /api/hardware. Drives the config
 * screen's capability chip + model-tier gating so a weak machine auto-disables
 * (or downgrades) local AI instead of hanging.
 */
export interface HardwareInfo {
  logical_cpus: number;
  total_ram_gb: number;
  has_accelerator: boolean;
  /** Probe's recommended tier: "off" | "lite" | "standard" | "max". */
  recommended_tier: Exclude<AiModelTier, "auto">;
  onnx_providers: string[];
}

export interface UpdateInfo {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  release_notes: string | null;
  published_at: string | null;
  checked_at: string;
  asset_url: string | null;
}

/**
 * Presentation grouping of the config fields, from GET /api/config/sections.
 * Drives the configure screen's section rail + per-section help. The backend's
 * `app/core/config_sections.py` is the source of the labels/descriptions; the
 * frontend supplies the icon + control body per id.
 */
export interface DirectoryEntry {
  name: string;
  path: string;
  is_dir: boolean;
  readable: boolean;
}

export interface DirectoryListing {
  path: string;
  /** `null` at a root, so the browser knows it cannot ascend further. */
  parent: string | null;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  entries: DirectoryEntry[];
}

export interface ConfigSectionMeta {
  id: string;
  label_key: string;
  description_key: string;
  label: string;
  description: string;
  fields: string[];
}

/**
 * One validation problem from POST /api/config/validate, tied to the flat
 * `Config` field that caused it (`null` for a problem not tied to a single
 * field). `message` is user-facing and rendered verbatim.
 */
export interface ConfigIssue {
  field: string | null;
  message: string;
  message_key: string;
  params: Record<string, string | number>;
}

export interface ValidateConfigResult {
  valid: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

export interface DiskSpaceResult {
  source_size_bytes: number;
  destination_free_bytes: number;
  sufficient: boolean;
  mode: "copy" | "move";
  /**
   * False when the backend could not read the destination's free space (e.g. a
   * permission error). When false, `destination_free_bytes` is not meaningful
   * and the UI should show an "unknown" state rather than "0 B free".
   */
  free_space_known?: boolean;
}

export type NumericOperator = "eq" | "gt" | "lt" | "gte" | "lte";

export type RuleCondition =
  | { type: "extension"; value: string }
  | { type: "filename_contains"; value: string }
  | { type: "size"; operator: NumericOperator; value: number }
  | { type: "resolution"; operator: NumericOperator; width: number; height: number };

export interface RuleBase {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  condition: RuleCondition;
}

export interface TagRule extends RuleBase {
  tag: string;
}

export interface RouteRule extends RuleBase {
  relative_folder: string;
}

export interface RuleSet {
  version: 1;
  tag_rules: TagRule[];
  route_rules: RouteRule[];
}

export interface TaskProgress {
  current: number;
  total: number;
  percentage: number;
  estimated_time_remaining_seconds?: number;
  unit?: "items" | "bytes";
  bytes_done?: number;
  bytes_total?: number;
  bytes_total_known?: boolean;
  /**
   * Terminal per-item outcomes tallied as they happen, keyed by the same status
   * codes the report uses (`sorted`, `duplicate`, `junk`, `name_collision`,
   * `failed`, …). This is what makes a live "so far" panel possible without
   * re-reading the operation log.
   */
  outcomes?: Record<string, number>;
  /**
   * Coarse setup/processing stage, so the UI can show meaningful feedback during
   * work that happens before the per-file loop instead of a frozen 0%.
   * Validation, source scan, destination index, ranking, and per-file phases.
   * Absent on older backends / synchronous calls.
   */
  phase?:
    | "validating"
    | "scanning_source"
    | "indexing_destination"
    | "ranking"
    | "analyzing"
    | "previewing"
    | "sorting"
    | "downloading_model"
    | "verifying_model"
    | "publishing_model"
    | null;
}

export interface TaskEvent {
  sequence: number;
  name: string;
  timestamp: string;
  phase: TaskProgress["phase"];
  fields: Record<string, unknown>;
}

export interface TaskFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface TaskStatus<TResult extends Record<string, unknown>> {
  task_id: string;
  operation_kind: "analysis" | "scan" | "preview" | "sort" | "model_download";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress: TaskProgress;
  partial: boolean;
  issues: Array<Record<string, unknown>>;
  events: TaskEvent[];
  last_event_sequence: number;
  error: string | null;
  failure: TaskFailure | null;
  result: TResult | null;
}

export type AiModelState = "not_installed" | "downloading" | "ready" | "error";

export interface AiModelPackStatus {
  pack_id: string;
  model_id: string;
  display_name: string;
  state: AiModelState;
  total_size: number;
  installed_size: number;
  license: string;
  license_url: string;
  source: string;
  task_id: string | null;
  error: string | null;
}

export interface AiModelInventory {
  effective_tier: "off" | "lite" | "standard" | "max";
  required_pack_id: string | null;
  packs: AiModelPackStatus[];
}

export type AiModelTaskStatus = TaskStatus<Record<string, unknown>>;

export const PROVENANCE_DECISION_KINDS = [
  "date",
  "category",
  "source_subfolder",
  "camera",
  "route",
  "rename",
  "conversion",
  "collision",
  "quarantine",
  "original_name",
] as const;

export type ProvenanceDecision = (typeof PROVENANCE_DECISION_KINDS)[number];

export interface OutcomeProvenance {
  date: {
    resolved_date: string | null;
    winning_source: string | null;
    candidates: Array<{
      source: string;
      value: string | null;
      accepted: boolean;
      rejection_reason:
        | "absent"
        | "unparseable"
        | "sentinel_value"
        | "suspicious"
        | "overridden"
        | null;
    }>;
  };
  rules: {
    matched_tags: Array<{ name: string; priority: number; saved_order: number }>;
    matched_routes: Array<{ name: string; priority: number; saved_order: number }>;
    winning_route: { name: string; priority: number; saved_order: number } | null;
    route_folder: string | null;
  };
  categorization: {
    enabled: boolean;
    label: string | null;
    confidence: number | null;
    threshold: number | null;
    passed: boolean | null;
  };
  duplicate: {
    evaluated: boolean;
    status: "unique" | "duplicate" | "unknown" | "not_evaluated";
    match_kind: string | null;
    matched_path: string | null;
    perceptual_distance: number | null;
  };
  unit: { unit_id: string; role: string; members: string[] } | null;
  path: Array<{ segment: string; decision: ProvenanceDecision; detail: string }>;
}

export interface PreviewItem {
  source: string;
  destination: string | null;
  extracted_date: string | null;
  metadata_source: string;
  tags: string[];
  /** Predicted Smart Categorization folder, or null (→ _uncategorized). */
  category?: string | null;
  status:
    | "sort"
    | "unknown_date"
    | "future_date"
    | "duplicate"
    | "failed"
    | "suspicious_date"
    | "junk"
    | "already_in_destination"
    | "duplicate_unknown"
    | "review_only"
    /** `deduplicate_only` run mode: neither duplicate nor junk, so it stays put. */
    | "keep_in_place";
  file_size?: number;
  /** Why the junk filter quarantined this file (junk status only). */
  quarantine_reason?: string | null;
  duplicate_type?: "exact" | "perceptual" | null;
  duplicate_similarity?: number | null;
  duplicate_of?: string | null;
  duplicate_evaluation?: "known" | "unknown";
  duplicate_unknown_reason?: "video_perceptual_not_computed" | null;
  /** Input root this item came from, retained for contextual-copy audit. */
  source_root?: string;
  /** Its own predicted path before it follows a duplicate keeper. */
  would_be_destination?: string | null;
  unit_id?: string;
  unit_primary?: boolean;
  companions?: Array<{
    source: string;
    destination: string | null;
    role: "edit_sidecar" | "motion_part" | "raw_sibling" | "thumbnail_part" | "audio_note";
    status: "attached" | "left_in_place";
    warning?: string | null;
    extracted_date?: string | null;
    placement_date_source?: string;
  }>;
  unit_warnings?: string[];
  provenance?: OutcomeProvenance;
}

/**
 * Displayable metadata for a single local file, from GET /api/media/info.
 *
 * Read by Review's detail view, one open file at a time. It carries the facts
 * the plan does not: a preview item knows where a file goes, not how many pixels
 * it has.
 */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  file_size: number | null;
  extracted_date: string | null;
  metadata_source: string;
  media_type: "image" | "video" | "other";
}

/** One candidate date the preview considered, and what became of it. */
export interface DateCandidate {
  source: string;
  value: string | null;
  accepted: boolean;
  rejection_reason:
    | "absent"
    | "unparseable"
    | "sentinel_value"
    | "suspicious"
    | "overridden"
    | null;
}

/** Provenance for one file, as `POST /api/review/outcomes` records it. */
export interface ReviewOutcome {
  source: string;
  resolved_date: string | null;
  candidates: DateCandidate[];
  provenance?: OutcomeProvenance;
}

export interface ReviewOutcomeResponse {
  config_fingerprint: string;
  outcomes: ReviewOutcome[];
  unavailable_paths: string[];
}

export interface AnalysisResult {
  total_files: number;
  total_size_bytes: number;
  by_type: Record<string, number>;
  date_range: {
    earliest: string | null;
    latest: string | null;
    no_date_estimate: number;
  };
  disk_space: {
    source_size_bytes: number;
    destination_free_bytes: number;
    sufficient: boolean;
    mode: "copy" | "move";
    /** See `DiskSpaceResult.free_space_known`. */
    free_space_known?: boolean;
  };
  excluded_files: number;
  estimated_duration_seconds: number;
  warnings: string[];
  partial: boolean;
  issues: Array<Record<string, unknown>>;
  media_units?: number;
  companion_files?: number;
  unmatched_companions?: number;
  /** Configured folders deliberately omitted from this run. */
  excluded_roots?: string[];
  excluded_root_ids?: string[];
}

export interface AuditFinding {
  finding_id: string;
  category:
    | "unreadable"
    | "structurally_invalid"
    | "content_extension_mismatch"
    | "checksum_divergence"
    | "missing_companion"
    | "placement_inconsistency";
  relative_path: string;
  evidence: string;
  actionable: boolean;
  newly_appeared: boolean;
  suggested_path: string | null;
}

export interface BurstFrame {
  frame_id: string;
  unit_id: string;
  primary_path: string;
  member_paths: string[];
  captured_at: string;
  camera_identity: string;
  perceptual_distance_from_previous: number | null;
  sharpness: number | null;
}

export interface BurstGroup {
  group_id: string;
  frames: BurstFrame[];
  proposed_representative_id: string;
  reviewed: boolean;
  dismissed: boolean;
  kept_frame_ids: string[];
}

export interface ReconciliationFinding {
  finding_id: string;
  classification: "missing" | "misplaced" | "extra" | "matched" | "unknown";
  identity: "confirmed" | "probable" | "unrelated" | "unknown";
  input_path: string | null;
  destination_path: string | null;
  expected_path: string | null;
  content_hash: string | null;
  perceptual_distance: number | null;
  metadata_agreement: boolean | null;
  measured_against: string;
  actionable: boolean;
  requires_explicit_confirmation: boolean;
  source_fingerprint: string | null;
  destination_fingerprint: string | null;
  unit_members: string[];
  unit_id: string | null;
  unit_member_roles: Record<string, string | null>;
  unit_member_fingerprints: Record<string, string>;
}

/**
 * What a run will do, counted by the plan itself.
 *
 * Always fetched rather than derived: Execute used to subtract a
 * per-reviewed-file tally from these action-level totals, and a companion is an
 * action but not a reviewed file — so excluding a RAW+JPEG pair left the
 * preflight promising a copy that would never happen.
 */
export interface PlanImpact {
  actionable_groups: number;
  copy_count: number;
  move_count: number;
  quarantine_count: number;
  quarantine_bytes: number;
  skip_count: number;
  source_mutations: number;
  required_bytes: number;
  conversion_without_originals: number;
  companions_left_in_place: number;
  embedded_tag_count: number;
  unresolved_count: number;
}

export interface PreviewResult {
  /** Identity of the exact configuration used to calculate these outcomes. */
  config_fingerprint: string;
  /** Identity of the immutable reviewed plan accepted by the executor. */
  plan_id: string;
  excluded_roots?: string[];
  excluded_root_ids?: string[];
  impact: PlanImpact;
  items: PreviewItem[];
  stats: {
    total: number;
    will_sort: number;
    will_fail: number;
    will_quarantine_unknown: number;
    will_quarantine_future: number;
    will_skip_duplicate: number;
    /** Junk/thumbnail files predicted to land in _junk/ (0 when the filter is off). */
    will_quarantine_junk: number;
    /** Files already present in the destination (destination-aware dedup). */
    will_skip_already_in_destination: number;
    /** Videos whose perceptual result is deferred until the real sort. */
    duplicate_unknown?: number;
    /** Sorted files predicted to land in _uncategorized/ (0 when categorize off). */
    uncategorized: number;
    partial?: boolean;
    issue_count?: number;
    eligible_media?: number;
    media_units?: number;
    companions?: number;
    unmatched_companions?: number;
    companion_split_warnings?: number;
    conversion_companion_warnings?: number;
  };
  partial: boolean;
  issues: Array<Record<string, unknown>>;
  unmatched_companions?: Array<{
    source: string;
    role: string;
    reason: string;
  }>;
}

export type SortingStatus = TaskStatus<{ operation_id?: string } & Record<string, unknown>>;
export type PreviewStatus = TaskStatus<PreviewResult & Record<string, unknown>>;
export type AnalysisStatus = TaskStatus<AnalysisResult & Record<string, unknown>>;
export type ScanStatus = TaskStatus<
  {
    files: string[];
    total: number;
    excluded_files: number;
    partial: boolean;
    issues: Array<Record<string, unknown>>;
    excluded_roots?: string[];
    excluded_root_ids?: string[];
  } & Record<string, unknown>
>;

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface DiagnosticsResponse {
  version: string;
  logging: Record<string, unknown>;
  operations_needing_review: string[];
  recovery_operations: RecoveryOperation[];
  rollout_gates: Record<string, boolean>;
  rollout_summary: string;
  thumbnail_cache: Record<string, unknown>;
}

export interface FileOperationRecord {
  id: string;
  operation_id: string;
  source_path: string;
  dest_path: string | null;
  extracted_date: string | null;
  metadata_source: string | null;
  action: string | null;
  status: string;
  error_message: string | null;
  file_size: number;
  file_type: string;
  tags: string[];
  /** Smart Categorization folder this file was routed into, or null. */
  category?: string | null;
  camera_model?: string | null;
  /** True when the EXIF sanity check flagged the date as bogus (e.g. camera clock reset). */
  suspicious?: boolean;
  duplicate_type?: "exact" | "perceptual" | null;
  duplicate_similarity?: number | null;
  duplicate_of?: string | null;
}

export interface OperationReport {
  operation_id: string;
  execution_date: string;
  source_path: string;
  dest_path: string;
  excluded_roots?: string[];
  duration_seconds: number | null;
  summary: {
    total: number;
    sorted: number;
    failed: number;
    duplicates: number;
    future_dates: number;
    unknown_dates: number;
    corrupted: number;
    /** Junk/thumbnail files quarantined to _junk/ (0 when the filter is off). */
    junk?: number;
    /** Files skipped because they already exist in the destination (0 when off). */
    already_in_destination?: number;
  };
  files: FileOperationRecord[];
  /** Aggregate breakdowns for the report dashboard (always present). */
  statistics?: {
    files_per_year: Record<string, number>;
    files_per_type: Record<string, number>;
    largest_files: { path: string; size_bytes: number }[];
    camera_models: Record<string, number>;
  };
}

export interface OperationListItem {
  id: string;
  execution_date: string;
  source_path: string;
  dest_path: string;
  total_files: number;
  files_sorted: number;
  files_failed: number;
  duplicates_found: number;
  duration_seconds: number | null;
}

export interface OperationListResponse {
  operations: OperationListItem[];
  total: number;
  limit: number;
  offset: number;
}

// ── Global loader tracking ───────────────────────────────────────────────────
//
// The app-wide "computing" bar should reflect only genuinely long operations
// (analysis, preview, sort, duplicate scan) — never config GETs, saves,
// validation, or unrelated background polling. Task hooks acquire this counter
// when an operation starts and release it only after a terminal status is
// observed. Components subscribe via the `useGlobalLoader` hook.

type LoaderListener = () => void;

let loaderCount = 0;
const loaderListeners = new Set<LoaderListener>();

export function subscribeLoader(listener: LoaderListener): () => void {
  loaderListeners.add(listener);
  return () => {
    loaderListeners.delete(listener);
  };
}

export function isLoaderActive(): boolean {
  return loaderCount > 0;
}

function bumpLoader(delta: number): void {
  loaderCount = Math.max(0, loaderCount + delta);
  loaderListeners.forEach((l) => l());
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTransientStartError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true;
  const status = error.response.status;
  return status === 408 || status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT");
}

// ── Client ─────────────────────────────────────────────────────────────────────

export class MediaSorterApiClient {
  private http: AxiosInstance;
  private ready: Promise<void>;
  private capability = "";

  constructor() {
    this.http = axios.create({ timeout: 30_000 });

    this.http.interceptors.response.use(
      (res) => res,
      (err: AxiosError<ApiError>) => {
        // Surface structured API errors as-is for callers to handle.
        return Promise.reject(err);
      },
    );

    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const session = await invoke<{ port: number; capability: string }>("get_api_session");
      this.http.defaults.baseURL = `http://127.0.0.1:${session.port}`;
      this.capability = session.capability;
    } catch {
      // Running outside Tauri (browser dev mode) or IPC not yet ready —
      // fall back to the default dev-mode port.
      this.http.defaults.baseURL = `http://127.0.0.1:8000`;
      this.capability = import.meta.env.VITE_MEDIASORT_API_CAPABILITY ?? "";
    }
    if (this.capability) {
      this.http.defaults.headers.common["X-MediaSorter-Capability"] = this.capability;
    }
  }

  /** Ensure the client has resolved the backend port before any call. */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * `fetch` against the loopback API with the capability header attached.
   *
   * Every media endpoint needs it, and neither a bare `fetch` nor an `<img
   * src>` carries it — which is why every thumbnail, hero image and difference
   * map in the app was answered with 401 and drew a "cannot preview this file"
   * placeholder instead. Images therefore go through here and are handed to the
   * DOM as object URLs.
   *
   * Shaped as `typeof fetch` and bound, so it can be passed straight to
   * anything that takes a fetcher.
   */
  readonly mediaFetch: typeof fetch = async (input, init) => {
    await this.ensureReady();
    const headers = new Headers(init?.headers);
    if (this.capability) headers.set("X-MediaSorter-Capability", this.capability);
    return fetch(input, { ...init, headers });
  };

  /** Keep the global loader active until the caller observes a terminal task state. */
  beginOperation(): () => void {
    bumpLoader(1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bumpLoader(-1);
    };
  }

  private async startTask(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey = newIdempotencyKey(),
  ): Promise<string> {
    await this.ensureReady();
    const delays = [250, 750];
    let lastError: unknown;
    let priorTimedOut = false;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const { data } = await this.http.post<{ task_id: string }>(
          path,
          {
            ...body,
            idempotency_key: idempotencyKey,
          },
          {
            headers:
              attempt > 0
                ? {
                    "X-MediaSorter-Retry-Attempt": String(attempt),
                    "X-MediaSorter-Transport-Event": priorTimedOut ? "timeout" : "retry",
                  }
                : undefined,
          },
        );
        return data.task_id;
      } catch (error) {
        lastError = error;
        priorTimedOut = isTimeoutError(error);
        if (!isTransientStartError(error) || attempt === delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
    throw lastError;
  }

  private async taskStatus<T>(path: string, afterSequence: number): Promise<T> {
    await this.ensureReady();
    const delays = [250, 750];
    let priorTimedOut = false;
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const { data } = await this.http.get<T>(path, {
          params: { after_sequence: afterSequence },
          headers:
            attempt > 0
              ? {
                  "X-MediaSorter-Retry-Attempt": String(attempt),
                  "X-MediaSorter-Transport-Event": priorTimedOut ? "timeout" : "retry",
                }
              : undefined,
        });
        return data;
      } catch (error) {
        lastError = error;
        priorTimedOut = isTimeoutError(error);
        if (!isTransientStartError(error) || attempt === delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
    throw lastError;
  }

  private async cancelTask(path: string): Promise<void> {
    await this.ensureReady();
    const delays = [250, 750];
    let priorTimedOut = false;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        await this.http.post(path, undefined, {
          headers:
            attempt > 0
              ? {
                  "X-MediaSorter-Retry-Attempt": String(attempt),
                  "X-MediaSorter-Transport-Event": priorTimedOut ? "timeout" : "retry",
                }
              : undefined,
        });
        return;
      } catch (error) {
        priorTimedOut = isTimeoutError(error);
        if (!isTransientStartError(error) || attempt === delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  // ── Health ───────────────────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    await this.ensureReady();
    const { data } = await this.http.get<HealthResponse>("/api/health");
    return data;
  }

  async diagnostics(): Promise<DiagnosticsResponse> {
    await this.ensureReady();
    const { data } = await this.http.get<DiagnosticsResponse>("/api/diagnostics");
    return data;
  }

  // ── Config ───────────────────────────────────────────────────────────────────

  async getConfig(): Promise<Config> {
    await this.ensureReady();
    const { data } = await this.http.get<Config>("/api/config");
    return data;
  }

  async saveConfig(patch: Partial<Config>): Promise<Config> {
    await this.ensureReady();
    const { data } = await this.http.post<Config>("/api/config", patch);
    return data;
  }

  async validateConfig(): Promise<ValidateConfigResult> {
    await this.ensureReady();
    const { data } = await this.http.post<ValidateConfigResult>("/api/config/validate", {});
    return data;
  }

  /**
   * List the sub-directories of one folder, and report what it permits.
   *
   * The same call browses and validates: a root's card state is derived from
   * this, so the folder a person picks is checked by the code that listed it.
   */
  async listDirectory(path: string): Promise<DirectoryListing> {
    await this.ensureReady();
    const { data } = await this.http.get<DirectoryListing>("/api/fs/list", {
      params: { path },
    });
    return data;
  }

  async getConfigSections(): Promise<ConfigSectionMeta[]> {
    await this.ensureReady();
    const { data } = await this.http.get<{ sections: ConfigSectionMeta[] }>("/api/config/sections");
    return data.sections;
  }

  /** Factory-default config — the source of truth for "deviates from default". */
  async getConfigDefaults(): Promise<Partial<Config>> {
    await this.ensureReady();
    const { data } = await this.http.get<Partial<Config>>("/api/config/defaults");
    return data;
  }

  /** The user's own saved recipes. Built-ins ship with the frontend. */
  async listRecipes(): Promise<SavedRecipe[]> {
    await this.ensureReady();
    const { data } = await this.http.get<SavedRecipe[]>("/api/config/recipes");
    return data;
  }

  /** Save the current run behaviour under a name, replacing any same-named one. */
  async saveRecipe(name: string, settings: RecipeSettings): Promise<SavedRecipe> {
    await this.ensureReady();
    const { data } = await this.http.post<SavedRecipe>("/api/config/recipes", { name, settings });
    return data;
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await this.ensureReady();
    await this.http.delete(`/api/config/recipes/${encodeURIComponent(recipeId)}`);
  }

  /** AI-relevant hardware profile (probed once at startup on the backend). */
  async getHardware(): Promise<HardwareInfo> {
    await this.ensureReady();
    const { data } = await this.http.get<HardwareInfo>("/api/hardware");
    return data;
  }

  async getAiModels(): Promise<AiModelInventory> {
    await this.ensureReady();
    const { data } = await this.http.get<AiModelInventory>("/api/ai/models");
    return data;
  }

  async installAiModel(packId: string): Promise<string> {
    return this.startTask(`/api/ai/models/${encodeURIComponent(packId)}/install`, {});
  }

  async getAiModelTask(taskId: string, afterSequence = 0): Promise<AiModelTaskStatus> {
    return this.taskStatus<AiModelTaskStatus>(
      `/api/ai/models/tasks/${encodeURIComponent(taskId)}`,
      afterSequence,
    );
  }

  async cancelAiModelInstall(taskId: string): Promise<void> {
    await this.cancelTask(`/api/ai/models/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  async removeAiModel(packId: string): Promise<AiModelPackStatus> {
    await this.ensureReady();
    const { data } = await this.http.delete<AiModelPackStatus>(
      `/api/ai/models/${encodeURIComponent(packId)}`,
      { data: { acknowledge_removal: true } },
    );
    return data;
  }

  async getDiskSpace(): Promise<DiskSpaceResult> {
    await this.ensureReady();
    const { data } = await this.http.get<DiskSpaceResult>("/api/analysis/disk-space");
    return data;
  }

  // ── Analysis ─────────────────────────────────────────────────────────────────

  async startAnalysis(
    excludedRootsOrIdempotencyKey: string[] | string = [],
    idempotencyKey?: string,
  ): Promise<string> {
    const excludedRoots = Array.isArray(excludedRootsOrIdempotencyKey)
      ? excludedRootsOrIdempotencyKey
      : [];
    const requestKey =
      typeof excludedRootsOrIdempotencyKey === "string"
        ? excludedRootsOrIdempotencyKey
        : idempotencyKey;
    return this.startTask("/api/analysis/start", { excluded_roots: excludedRoots }, requestKey);
  }

  async getAnalysisStatus(taskId: string, afterSequence = 0): Promise<AnalysisStatus> {
    return this.taskStatus<AnalysisStatus>(`/api/analysis/${taskId}`, afterSequence);
  }

  async cancelAnalysis(taskId: string): Promise<void> {
    await this.cancelTask(`/api/analysis/${taskId}/cancel`);
  }

  // ── Source scan ──────────────────────────────────────────────────────────────

  async startScan(
    excludedRootsOrIdempotencyKey: string[] | string = [],
    idempotencyKey?: string,
  ): Promise<string> {
    const excludedRoots = Array.isArray(excludedRootsOrIdempotencyKey)
      ? excludedRootsOrIdempotencyKey
      : [];
    const requestKey =
      typeof excludedRootsOrIdempotencyKey === "string"
        ? excludedRootsOrIdempotencyKey
        : idempotencyKey;
    return this.startTask("/api/scan/start", { excluded_roots: excludedRoots }, requestKey);
  }

  async getScanStatus(taskId: string, afterSequence = 0): Promise<ScanStatus> {
    return this.taskStatus<ScanStatus>(`/api/scan/${taskId}`, afterSequence);
  }

  async cancelScan(taskId: string): Promise<void> {
    await this.cancelTask(`/api/scan/${taskId}/cancel`);
  }

  // ── Preview (background task + progress polling) ──────────────────────────────

  async startPreview(
    excludedRootsOrIdempotencyKey: string[] | string = [],
    idempotencyKey?: string,
  ): Promise<string> {
    const excludedRoots = Array.isArray(excludedRootsOrIdempotencyKey)
      ? excludedRootsOrIdempotencyKey
      : [];
    const requestKey =
      typeof excludedRootsOrIdempotencyKey === "string"
        ? excludedRootsOrIdempotencyKey
        : idempotencyKey;
    return this.startTask("/api/preview/start", { excluded_roots: excludedRoots }, requestKey);
  }

  async getPreviewStatus(taskId: string, afterSequence = 0): Promise<PreviewStatus> {
    return this.taskStatus<PreviewStatus>(`/api/preview/${taskId}`, afterSequence);
  }

  async cancelPreview(taskId: string): Promise<void> {
    await this.cancelTask(`/api/preview/${taskId}/cancel`);
  }

  // ── Sorting ──────────────────────────────────────────────────────────────────

  /**
   * Start a run.
   *
   * `excludedRoots` is the Sources-stage scope and `reviewedSets` contains the
   * duplicate confirmations. Both belong to this run only.
   *
   * A decision is set-level — `{ keep, demote }` — rather than a `{hash: path}`
   * map, because promoting a copy changes the planned action of every *other*
   * copy too. A map could name the winner but not the losers, and the plan
   * guard would then abort the run on the first action it did not recognise.
   */
  async startSort(
    dryRun = false,
    idempotencyKey?: string,
    expectedConfigFingerprint?: string,
    planId?: string,
    decisions: { excludedRoots?: string[]; reviewedSets?: ReviewedSet[] } = {},
  ): Promise<string> {
    return this.startTask(
      "/api/sorting/start",
      {
        dry_run: dryRun,
        expected_config_fingerprint: expectedConfigFingerprint,
        plan_id: planId,
        excluded_roots: decisions.excludedRoots ?? [],
        reviewed_sets: decisions.reviewedSets ?? [],
      },
      idempotencyKey,
    );
  }

  async getSortStatus(taskId: string, afterSequence = 0): Promise<SortingStatus> {
    return this.taskStatus<SortingStatus>(`/api/sorting/${taskId}`, afterSequence);
  }

  async cancelSort(taskId: string): Promise<void> {
    await this.cancelTask(`/api/sorting/${taskId}/cancel`);
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  async listReports(limit = 20, offset = 0): Promise<OperationListResponse> {
    await this.ensureReady();
    const { data } = await this.http.get<OperationListResponse>("/api/reports", {
      params: { limit, offset },
    });
    return data;
  }

  async clearHistory(): Promise<void> {
    await this.ensureReady();
    await this.http.delete("/api/reports");
  }

  async getReport(operationId: string): Promise<OperationReport> {
    await this.ensureReady();
    const { data } = await this.http.get<OperationReport>(`/api/reports/${operationId}`);
    return data;
  }

  async exportReport(operationId: string, format: "csv" | "json"): Promise<Blob> {
    await this.ensureReady();
    const { data } = await this.http.post(
      `/api/reports/${operationId}/export`,
      { format },
      { responseType: "blob" },
    );
    return data as Blob;
  }

  /**
   * What a run carrying this scope and these duplicate decisions would do.
   */
  async planImpact(
    planId: string,
    excludedRoots: string[],
    reviewedSets: ReviewedSet[] = [],
  ): Promise<PlanImpact> {
    await this.ensureReady();
    const { data } = await this.http.post<PlanImpact>("/api/sorting/impact", {
      plan_id: planId,
      excluded_roots: excludedRoots,
      reviewed_sets: reviewedSets,
    });
    return data;
  }

  // ── Duplicate review ──────────────────────────────────────────────────────────

  async listReviewGroups(
    kind: GroupKind = "exact",
    options: { limit?: number; maxDistance?: number; excludedRoots?: string[] } = {},
  ): Promise<{ groups: ReviewGroup[]; next_cursor: string | null; kind: string }> {
    await this.ensureReady();
    const { data } = await this.http.get<{
      groups: ReviewGroup[];
      next_cursor: string | null;
      kind: string;
    }>("/api/review/groups", {
      params: {
        kind,
        limit: options.limit ?? 50,
        max_distance: options.maxDistance ?? 2,
        excluded_roots: options.excludedRoots ?? [],
      },
    });
    return data;
  }

  /**
   * Record one review decision. A reference member is refused with 409 — the
   * backend enforces that, so the UI's disabled controls are a courtesy rather
   * than the protection itself.
   */
  async decideReview(input: {
    planId?: string;
    groupId: string;
    memberId: string;
    action: string;
    reason?: string;
  }): Promise<ReviewGroupPlan> {
    await this.ensureReady();
    const { data } = await this.http.post<ReviewGroupPlan>("/api/review/decide", {
      plan_id: input.planId ?? "default",
      group_id: input.groupId,
      member_id: input.memberId,
      action: input.action,
      reason: input.reason ?? "",
    });
    return data;
  }

  async quarantineAllExcept(
    groupId: string,
    keepMemberIds: string[],
    planId = "default",
  ): Promise<ReviewGroupPlan> {
    await this.ensureReady();
    const { data } = await this.http.post<ReviewGroupPlan>("/api/review/quarantine-all-except", {
      plan_id: planId,
      group_id: groupId,
      keep_member_ids: keepMemberIds,
    });
    return data;
  }

  async undoReview(groupId: string, planId = "default"): Promise<ReviewGroupPlan> {
    await this.ensureReady();
    const { data } = await this.http.post<ReviewGroupPlan>("/api/review/undo", {
      plan_id: planId,
      group_id: groupId,
    });
    return data;
  }

  async previewPolicy(input: {
    scope: string;
    groupIds?: string[];
    policyId?: string;
    filterKey?: string;
    planId?: string;
  }): Promise<BulkImpactResponse> {
    await this.ensureReady();
    const { data } = await this.http.post<BulkImpactResponse>("/api/review/policy/preview", {
      plan_id: input.planId ?? "default",
      scope: input.scope,
      group_ids: input.groupIds ?? [],
      // Omitted rather than defaulted: the backend falls back to the
      // configured keep rule, so the client never has to restate it.
      policy_id: input.policyId ?? null,
      filter_key: input.filterKey ?? "",
    });
    return data;
  }

  async applyPolicy(input: {
    scope: string;
    impact: BulkImpactResponse;
    groupIds?: string[];
    policyId?: string;
    preferredRoots?: string[];
    filterKey?: string;
    planId?: string;
  }): Promise<{ applied_groups: number }> {
    await this.ensureReady();
    const { data } = await this.http.post<{ applied_groups: number }>("/api/review/policy/apply", {
      plan_id: input.planId ?? "default",
      scope: input.scope,
      impact: input.impact,
      group_ids: input.groupIds ?? [],
      policy_id: input.policyId ?? null,
      preferred_roots: input.preferredRoots ?? [],
      filter_key: input.filterKey ?? "",
    });
    return data;
  }

  /** What enabling the high-confidence similar rule would affect, before consent. */
  async previewSimilarRule(
    input: {
      maxDistance?: number;
      requireSameDimensions?: boolean;
    } = {},
  ): Promise<SimilarRulePreview> {
    await this.ensureReady();
    const { data } = await this.http.post<SimilarRulePreview>("/api/review/similar-rule/preview", {
      max_distance: input.maxDistance ?? 0,
      require_same_dimensions: input.requireSameDimensions ?? true,
    });
    return data;
  }

  async snapshotReview(
    acknowledgeSourceMutations = false,
    planId = "default",
  ): Promise<{ snapshot: Record<string, unknown>; stale_groups: string[] }> {
    await this.ensureReady();
    const { data } = await this.http.post("/api/review/snapshot", {
      plan_id: planId,
      acknowledge_source_mutations: acknowledgeSourceMutations,
    });
    return data as { snapshot: Record<string, unknown>; stale_groups: string[] };
  }

  async runValidation(rootId: string, checks?: string[]): Promise<ValidationReport> {
    await this.ensureReady();
    const { data } = await this.http.get<ValidationReport>("/api/review/validation", {
      params: { root_id: rootId, ...(checks ? { checks: checks.join(",") } : {}) },
    });
    return data;
  }

  /**
   * One page of the library, read from the catalog by cursor.
   *
   * The totals come from the same filter as the rows, so a header can never
   * describe a different set than the list under it. A cursor from a different
   * query is refused with 400 rather than reinterpreted.
   */
  async listCatalogView(
    options: {
      cursor?: string | null;
      limit?: number;
      roles?: string[];
      sort?: "path" | "size" | "modified";
      descending?: boolean;
      search?: string;
      includeTotals?: boolean;
    } = {},
  ): Promise<CatalogViewPage> {
    await this.ensureReady();
    const { data } = await this.http.get<CatalogViewPage>("/api/review/view", {
      params: {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit ?? 100,
        roles: (options.roles ?? ["input", "destination", "reference"]).join(","),
        sort: options.sort ?? "path",
        descending: options.descending ?? false,
        search: options.search ?? "",
        include_totals: options.includeTotals ?? true,
      },
    });
    return data;
  }

  // ── Quarantine cleanup ────────────────────────────────────────────────────────

  /** Permanently delete quarantined files. The only irreversible call here. */
  // ── Catalog ───────────────────────────────────────────────────────────────────

  async catalogDiagnostics(): Promise<CatalogDiagnostics> {
    await this.ensureReady();
    const { data } = await this.http.get<CatalogDiagnostics>("/api/catalog/diagnostics");
    return data;
  }

  /**
   * Forget indexed facts so they are recomputed. Media is never touched.
   *
   * A `rootId` drops one root; omitting it deletes the whole index and needs
   * `confirmFullReset`, because that throws away every hash this machine has
   * ever computed.
   */
  async rebuildCatalog(
    options: { rootId?: string; confirmFullReset?: boolean } = {},
  ): Promise<{ reset: boolean; path: string }> {
    await this.ensureReady();
    const { data } = await this.http.post<{ reset: boolean; path: string }>(
      "/api/catalog/rebuild",
      {
        root_id: options.rootId ?? null,
        confirm_full_reset: options.confirmFullReset ?? false,
      },
    );
    return data;
  }

  // ── Update checker ────────────────────────────────────────────────────────────

  async checkUpdate(force = false): Promise<UpdateInfo> {
    await this.ensureReady();
    const { data } = await this.http.get<UpdateInfo>("/api/update", {
      params: force ? { force: "true" } : {},
    });
    return data;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────────

  getWebSocketUrl(): string {
    const base = this.http.defaults.baseURL ?? "http://127.0.0.1:8000";
    return base.replace(/^http/, "ws") + "/api/logs";
  }

  getWebSocketProtocol(): string {
    return `mediasorter.${this.capability}`;
  }

  // ── AI utilities ─────────────────────────────────────────────────────────────

  async suggestCategories(n: number = 5): Promise<{ suggestions: string[] }> {
    await this.ensureReady();
    const { data } = await this.http.post<{ suggestions: string[] }>("/api/ai/suggest-categories", {
      n_categories: Math.max(2, Math.min(12, n)),
    });
    return data;
  }

  // ── Thumbnails ────────────────────────────────────────────────────────────────

  /**
   * Absolute URL for a file's thumbnail, for use as an `<img>` src. Returns a
   * JPEG for images; videos / unreadable files respond 415 so the `<img>` fires
   * `onError` and the caller can show a placeholder. Lazy by nature — nothing is
   * fetched until the element mounts.
   */
  thumbnailUrl(path: string, maxPx?: number): string {
    const base = this.http.defaults.baseURL ?? "http://127.0.0.1:8000";
    // `maxPx` is the longest-edge size the caller wants rendered. Callers should
    // pass roughly 2× their CSS display size so the image stays crisp on HiDPI
    // displays. Omit it to keep the backend's small default (hover thumbnails).
    const size = maxPx ? `&size=${Math.round(maxPx)}` : "";
    return `${base}/api/thumbnail?path=${encodeURIComponent(path)}${size}`;
  }

  /**
   * Resolution / size / date metadata for a single file. Lightweight enough to
   * fetch on hover; cached by the caller (TanStack Query) so the modal and
   * compare views reuse it.
   */
  async getMediaInfo(path: string): Promise<MediaInfo> {
    await this.ensureReady();
    const { data } = await this.http.get<MediaInfo>("/api/media/info", {
      params: { path },
    });
    return data;
  }

  /**
   * What the last completed preview recorded about how each date was chosen.
   *
   * The candidates it considered, which one won, and why the others were
   * rejected — the provenance behind the one-sentence reason every row carries.
   * Capped at 500 paths by the endpoint, and asked for one file at a time by the
   * only caller that needs it.
   */
  async reviewOutcomes(paths: string[]): Promise<ReviewOutcomeResponse> {
    await this.ensureReady();
    const { data } = await this.http.post<ReviewOutcomeResponse>("/api/review/outcomes", {
      paths,
    });
    return data;
  }

  /**
   * Absolute URL for a difference heat-map between two images, for use as an
   * `<img>` src in the duplicate comparison. Non-image inputs respond 415 so the
   * `<img>` fires `onError` and the caller can hide the diff affordance.
   */
  diffUrl(a: string, b: string, maxPx?: number): string {
    const base = this.http.defaults.baseURL ?? "http://127.0.0.1:8000";
    const size = maxPx ? `&size=${Math.round(maxPx)}` : "";
    return `${base}/api/media/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${size}`;
  }
}

export const api = new MediaSorterApiClient();
