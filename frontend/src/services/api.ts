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
  convert_images: boolean;
  image_format: "jpeg" | "png" | "webp" | "tiff";
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
  analyze: boolean;
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
}

export type LibraryRootRole = "input" | "reference" | "destination";
export type TransferMode = "copy" | "move";

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

/** One declared format contract: what an optimizer would promise, and prove. */
export interface OptimizationContract {
  contract_id: string;
  media_kind: "image" | "video";
  mode: "disabled" | "lossless" | "visually_lossless";
  status: "declared" | "validated" | "blocked";
  enabled: boolean;
  source_formats: string[];
  output_container: string;
  output_codec: string;
  tool: string;
  tool_available: boolean;
  tool_version: string | null;
  minimum_tool_version: string;
  decoded_content: string;
  metadata_policy: string;
  quality_setting: string;
  metrics: {
    name: string;
    comparison: string;
    threshold: number | string | boolean;
    applies_to: string;
    rationale: string;
  }[];
  compatibility_warnings: string[];
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

export interface OptimizationProjection {
  contract_id: string;
  mode: "disabled" | "lossless" | "visually_lossless";
  output_container: string;
  output_codec: string;
  item_count: number;
  current_bytes: number;
  projected_low_bytes: number | null;
  projected_high_bytes: number | null;
  estimated_saving_bytes: number | null;
  confidence: "measured" | "sampled" | "estimated" | "unknown";
  estimate_only: boolean;
  recommended_count: number;
  skipped_count: number;
  blocked_count: number;
  temporary_space_bytes: number;
  quarantine_space_bytes: number;
  samples: SampleEncode[];
  items: ItemProjection[];
  warnings: string[];
  compatibility_warnings: string[];
  failures: string[];
}

/** A quarantined original and everything needed to put it back. */
export interface QuarantineRecord {
  record_id: string;
  operation_id: string;
  reason: string;
  original_path: string;
  quarantine_path: string;
  keeper_path: string | null;
  size_bytes: number;
  quarantined_at: string;
  retention: "retained" | "restored" | "removed";
  restored_to: string | null;
  age_days: number;
  notes: string[];
}

export interface QuarantineSummary {
  record_count: number;
  retained_count: number;
  restored_count: number;
  retained_bytes: number;
  oldest_age_days: number;
  by_reason: Record<string, number>;
}

export interface RestorePreview {
  record_id: string;
  target_path: string;
  restorable: boolean;
  conflict: boolean;
  conflict_is_identical: boolean;
  quarantined_file_present: boolean;
  hash_matches: boolean | null;
  blocked_reason: string | null;
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
  GroupPlan as ReviewGroupPlan,
} from "@/lib/reviewWorkbench";

export type { ReviewGroup, ReviewGroupPlan };
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

export interface CleanupImpact {
  record_ids: string[];
  item_count: number;
  total_bytes: number;
  excluded_reasons: string[];
  acknowledgement_text: string;
}

export interface CleanupOutcome {
  code: string;
  removed: string[];
  failed: { record_id: string; reason: string }[];
  bytes_removed: number;
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
  operation_kind: "analysis" | "scan" | "preview" | "sort";
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
    | "review_only";
  file_size?: number;
  /** Why the junk filter quarantined this file (junk status only). */
  quarantine_reason?: string | null;
  duplicate_type?: "exact" | "perceptual" | null;
  duplicate_similarity?: number | null;
  duplicate_of?: string | null;
  duplicate_evaluation?: "known" | "unknown";
  duplicate_unknown_reason?: "video_perceptual_not_computed" | null;
  unit_id?: string;
  unit_primary?: boolean;
  companions?: Array<{
    source: string;
    destination: string | null;
    role:
      | "edit_sidecar"
      | "motion_part"
      | "raw_sibling"
      | "thumbnail_part"
      | "audio_note";
    status: "attached" | "left_in_place";
    warning?: string | null;
    extracted_date?: string | null;
    placement_date_source?: string;
  }>;
  unit_warnings?: string[];
  provenance?: {
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
    path: Array<{ segment: string; decision: string; detail: string }>;
  };
}

/**
 * Displayable metadata for a single local file, from GET /api/media/info.
 * Used to show resolution everywhere and to fill in a duplicate original's
 * details (date/source/size), which the preview item itself doesn't carry.
 */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  file_size: number | null;
  extracted_date: string | null;
  metadata_source: string;
  media_type: "image" | "video" | "other";
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

export interface AuditActionPlan {
  plan_id: string;
  action_count: number;
  bytes_affected: number;
  source_mutations: number;
  config_fingerprint: string;
}

export interface AuditReport {
  audit_id: string;
  root: string;
  started_at: string;
  finished_at: string;
  scope: {
    subtree: string | null;
    date_from: string | null;
    date_to: string | null;
    sample_proportion: number;
    sample_seed: string;
  };
  selection_method: string;
  coverage: "full" | "sample" | "partial";
  scanned_files: number;
  baseline_established: number;
  findings: AuditFinding[];
  issues: string[];
  cancelled: boolean;
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

export interface BurstDecision {
  group: BurstGroup;
  plan: {
    plan_id: string;
    group_id: string;
    kept_frame_ids: string[];
    members: Array<{
      frame_id: string;
      unit_id: string;
      path: string;
      fingerprint: string;
    }>;
  };
  impact: {
    quarantine_count: number;
    quarantine_bytes: number;
    source_mutations: number;
    irreversible: string;
  };
  planned_quarantine_units: Array<{
    unit_id: string;
    members: string[];
    action: "quarantine";
    delete: false;
  }>;
}

export interface BurstRunReport {
  operation_id: string;
  plan_id: string;
  group_id: string;
  completed_at: string;
  kept_frame_ids: string[];
  quarantined: Array<{
    frame_id: string;
    unit_id: string;
    original_path: string;
    quarantine_path: string;
    size_bytes: number;
  }>;
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

export interface ReconciliationReport {
  report_id: string;
  created_at: string;
  findings: ReconciliationFinding[];
  next_cursor: string | null;
  counts: Record<ReconciliationFinding["classification"], number>;
  input_coverage: "full" | "partial" | "unavailable";
  destination_coverage: "full" | "partial" | "unavailable";
  issues: string[];
  config_fingerprint: string;
}

export interface ReconciliationPlan {
  plan_id: string;
  manifest: Record<string, unknown>;
  action_count: number;
  bytes_affected: number;
  source_mutations: number;
}

export interface PreviewResult {
  /** Identity of the exact configuration used to calculate these outcomes. */
  config_fingerprint: string;
  /** Identity of the immutable reviewed plan accepted by the executor. */
  plan_id: string;
  impact: {
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
  };
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
      const port: number = await invoke<number>("get_api_port");
      this.http.defaults.baseURL = `http://127.0.0.1:${port}`;
    } catch {
      // Running outside Tauri (browser dev mode) or IPC not yet ready —
      // fall back to the default dev-mode port.
      this.http.defaults.baseURL = `http://127.0.0.1:8000`;
    }
  }

  /** Ensure the client has resolved the backend port before any call. */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

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

  /** AI-relevant hardware profile (probed once at startup on the backend). */
  async getHardware(): Promise<HardwareInfo> {
    await this.ensureReady();
    const { data } = await this.http.get<HardwareInfo>("/api/hardware");
    return data;
  }

  async getDiskSpace(): Promise<DiskSpaceResult> {
    await this.ensureReady();
    const { data } = await this.http.get<DiskSpaceResult>("/api/analysis/disk-space");
    return data;
  }

  // ── Analysis ─────────────────────────────────────────────────────────────────

  async startAnalysis(idempotencyKey?: string): Promise<string> {
    return this.startTask("/api/analysis/start", {}, idempotencyKey);
  }

  async getAnalysisStatus(taskId: string, afterSequence = 0): Promise<AnalysisStatus> {
    return this.taskStatus<AnalysisStatus>(`/api/analysis/${taskId}`, afterSequence);
  }

  async cancelAnalysis(taskId: string): Promise<void> {
    await this.cancelTask(`/api/analysis/${taskId}/cancel`);
  }

  // ── Source scan ──────────────────────────────────────────────────────────────

  async startScan(idempotencyKey?: string): Promise<string> {
    return this.startTask("/api/scan/start", {}, idempotencyKey);
  }

  async getScanStatus(taskId: string, afterSequence = 0): Promise<ScanStatus> {
    return this.taskStatus<ScanStatus>(`/api/scan/${taskId}`, afterSequence);
  }

  async cancelScan(taskId: string): Promise<void> {
    await this.cancelTask(`/api/scan/${taskId}/cancel`);
  }

  // ── Preview (background task + progress polling) ──────────────────────────────

  async startPreview(idempotencyKey?: string): Promise<string> {
    return this.startTask("/api/preview/start", {}, idempotencyKey);
  }

  async getPreviewStatus(taskId: string, afterSequence = 0): Promise<PreviewStatus> {
    return this.taskStatus<PreviewStatus>(`/api/preview/${taskId}`, afterSequence);
  }

  async cancelPreview(taskId: string): Promise<void> {
    await this.cancelTask(`/api/preview/${taskId}/cancel`);
  }

  // ── Sorting ──────────────────────────────────────────────────────────────────

  async startSort(
    dryRun = false,
    idempotencyKey?: string,
    expectedConfigFingerprint?: string,
    planId?: string,
  ): Promise<string> {
    return this.startTask(
      "/api/sorting/start",
      {
        dry_run: dryRun,
        expected_config_fingerprint: expectedConfigFingerprint,
        plan_id: planId,
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

  async runLibraryAudit(input: {
    root: string;
    subtree?: string;
    sampleProportion?: number;
  }): Promise<AuditReport> {
    await this.ensureReady();
    const { data } = await this.http.post<AuditReport>("/api/audit", {
      root: input.root,
      scope: {
        subtree: input.subtree || null,
        sample_proportion: input.sampleProportion ?? 1,
      },
    });
    return data;
  }

  async auditHistory(): Promise<AuditReport[]> {
    await this.ensureReady();
    const { data } = await this.http.get<AuditReport[]>("/api/audit/history");
    return data;
  }

  async exportAudit(auditId: string, format: "csv" | "json"): Promise<Blob> {
    await this.ensureReady();
    const { data } = await this.http.post(
      `/api/audit/reports/${encodeURIComponent(auditId)}/export`,
      { format },
      { responseType: "blob" },
    );
    return data as Blob;
  }

  async planAuditFixes(auditId: string, findingIds: string[]): Promise<AuditActionPlan> {
    await this.ensureReady();
    const { data } = await this.http.post<AuditActionPlan>(
      `/api/audit/reports/${encodeURIComponent(auditId)}/plan`,
      { finding_ids: findingIds },
    );
    return data;
  }

  async executeAuditFixes(
    planId: string,
  ): Promise<{ plan_id: string; completed: number }> {
    await this.ensureReady();
    const { data } = await this.http.post<{ plan_id: string; completed: number }>(
      `/api/audit/plans/${encodeURIComponent(planId)}/execute`,
      { acknowledged: true },
    );
    return data;
  }

  async detectBursts(root: string, paths: string[]): Promise<BurstGroup[]> {
    await this.ensureReady();
    const { data } = await this.http.post<BurstGroup[]>("/api/review/bursts/detect", {
      root,
      paths,
    });
    return data;
  }

  async decideBurst(
    group: BurstGroup,
    keepFrameIds: string[],
    dismissed = false,
  ): Promise<BurstDecision> {
    await this.ensureReady();
    const { data } = await this.http.post("/api/review/bursts/decision", {
      group,
      keep_frame_ids: keepFrameIds,
      dismissed,
    });
    return data;
  }

  async executeBurstPlan(planId: string): Promise<BurstRunReport> {
    await this.ensureReady();
    const { data } = await this.http.post<BurstRunReport>(
      `/api/review/bursts/plans/${encodeURIComponent(planId)}/execute`,
      { acknowledged: true },
    );
    return data;
  }

  async reconcileDestination(): Promise<ReconciliationReport> {
    await this.ensureReady();
    const { data } = await this.http.post<ReconciliationReport>(
      "/api/reconciliation/compare",
      { input_available: true },
    );
    return data;
  }

  async reconciliationFindings(
    reportId: string,
    options: {
      cursor?: string | null;
      classification?: ReconciliationFinding["classification"];
      limit?: number;
    } = {},
  ): Promise<ReconciliationReport> {
    await this.ensureReady();
    const { data } = await this.http.get<ReconciliationReport>(
      `/api/reconciliation/reports/${encodeURIComponent(reportId)}/findings`,
      {
        params: {
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.classification ? { classification: options.classification } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        },
      },
    );
    return data;
  }

  async planReconciliation(
    report: ReconciliationReport,
    findingIds: string[],
    confirmedProbable: string[],
  ): Promise<ReconciliationPlan> {
    await this.ensureReady();
    const { data } = await this.http.post<ReconciliationPlan>(
      "/api/reconciliation/plan",
      {
        report_id: report.report_id,
        finding_ids: findingIds,
        confirm_probable: confirmedProbable,
      },
    );
    return data;
  }

  async executeReconciliation(
    planId: string,
  ): Promise<{ plan_id: string; completed: number }> {
    await this.ensureReady();
    const { data } = await this.http.post<{ plan_id: string; completed: number }>(
      `/api/reconciliation/plans/${encodeURIComponent(planId)}/execute`,
      { acknowledged: true },
    );
    return data;
  }

  // ── Optimization ──────────────────────────────────────────────────────────────

  /** Every declared contract with its status and whether its tool exists here. */
  async listOptimizationContracts(): Promise<OptimizationContract[]> {
    await this.ensureReady();
    const { data } = await this.http.get<OptimizationContract[]>("/api/optimization/contracts");
    return data;
  }

  /**
   * Project what optimization would cost and save for the given files.
   *
   * Nothing is mutated: the backend encodes a bounded sample into its own
   * workspace. With `retainSamples` the candidates stay readable so the
   * comparison modal has something real to show; without it the response is
   * numbers only and says so via `estimate_only`.
   */
  async previewOptimization(
    contractId: string,
    paths: string[],
    options: { retainSamples?: boolean; maxSamples?: number } = {},
  ): Promise<OptimizationProjection> {
    await this.ensureReady();
    const { data } = await this.http.post<OptimizationProjection>("/api/optimization/preview", {
      contract_id: contractId,
      paths,
      retain_samples: options.retainSamples ?? true,
      max_samples: options.maxSamples ?? 3,
    });
    return data;
  }

  // ── Quarantine ────────────────────────────────────────────────────────────────

  async listQuarantine(retention?: QuarantineRecord["retention"]): Promise<QuarantineRecord[]> {
    await this.ensureReady();
    const { data } = await this.http.get<QuarantineRecord[]>("/api/quarantine", {
      params: retention ? { retention } : {},
    });
    return data;
  }

  async quarantineSummary(): Promise<QuarantineSummary> {
    await this.ensureReady();
    const { data } = await this.http.get<QuarantineSummary>("/api/quarantine/summary");
    return data;
  }

  /** Describe a restore fully before any byte moves. */
  async previewRestore(
    recordId: string,
    options: { targetPath?: string; onConflict?: "block" | "alternate_path" | "skip" } = {},
  ): Promise<RestorePreview> {
    await this.ensureReady();
    const { data } = await this.http.post<RestorePreview>("/api/quarantine/restore/preview", {
      record_id: recordId,
      target_path: options.targetPath ?? null,
      on_conflict: options.onConflict ?? "block",
    });
    return data;
  }

  // ── Duplicate review ──────────────────────────────────────────────────────────

  async listReviewGroups(
    kind: "exact" | "similar" = "exact",
    options: { limit?: number; maxDistance?: number } = {},
  ): Promise<{ groups: ReviewGroup[]; next_cursor: string | null; kind: string }> {
    await this.ensureReady();
    const { data } = await this.http.get<{
      groups: ReviewGroup[];
      next_cursor: string | null;
      kind: string;
    }>("/api/review/groups", {
      params: { kind, limit: options.limit ?? 50, max_distance: options.maxDistance ?? 2 },
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
      policy_id: input.policyId ?? "largest",
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
      policy_id: input.policyId ?? "largest",
      preferred_roots: input.preferredRoots ?? [],
      filter_key: input.filterKey ?? "",
    });
    return data;
  }

  /** What enabling the high-confidence similar rule would affect, before consent. */
  async previewSimilarRule(input: {
    maxDistance?: number;
    requireSameDimensions?: boolean;
  } = {}): Promise<SimilarRulePreview> {
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
  async listCatalogView(options: {
    cursor?: string | null;
    limit?: number;
    roles?: string[];
    sort?: "path" | "size" | "modified";
    descending?: boolean;
    search?: string;
    includeTotals?: boolean;
  } = {}): Promise<CatalogViewPage> {
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

  async previewCleanup(recordIds: string[]): Promise<CleanupImpact> {
    await this.ensureReady();
    const { data } = await this.http.post<CleanupImpact>("/api/quarantine/cleanup/preview", {
      record_ids: recordIds,
    });
    return data;
  }

  /** Permanently delete quarantined files. The only irreversible call here. */
  async cleanupQuarantine(
    recordIds: string[],
    acknowledge: boolean,
  ): Promise<CleanupOutcome> {
    await this.ensureReady();
    const { data } = await this.http.post<CleanupOutcome>("/api/quarantine/cleanup", {
      record_ids: recordIds,
      acknowledge_permanent_deletion: acknowledge,
    });
    return data;
  }

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
    const { data } = await this.http.post<{ reset: boolean; path: string }>("/api/catalog/rebuild", {
      root_id: options.rootId ?? null,
      confirm_full_reset: options.confirmFullReset ?? false,
    });
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
