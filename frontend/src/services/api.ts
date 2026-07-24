/**
 * Type-safe HTTP client for the MediaSorter FastAPI backend.
 *
 * Port is resolved at runtime from Tauri state so there are no hardcoded values.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { invoke } from "@tauri-apps/api/tauri";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Config {
  source_directory: string;
  target_directory: string;
  sort: boolean;
  sort_criteria: string[];
  recursive_scan: boolean;
  max_recursion_depth: number | null;
  preserve_subfolders: boolean;
  override_metadata: boolean;
  copy_instead_of_move: boolean;
  rename: boolean;
  rename_pattern: string;
  remove_duplicates: boolean;
  duplicate_exact_enabled: boolean;
  duplicate_perceptual_enabled: boolean;
  duplicate_perceptual_threshold: number;
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
  rules: Rule[];
  ai_tagging_enabled: boolean;
  ai_tagging_provider: "local" | "azure_vision" | "imagga" | "google_cloud_vision";
  ai_tagging_confidence_threshold: number;
  ai_tagging_api_key: string | null;
  ai_tagging_api_secret: string | null;
  ai_tagging_endpoint: string | null;
  ai_tagging_max_tags: number;
  ai_tagging_embed_in_files: boolean;
  ai_tagging_labels: string[];
  // Smart Categorization — independent of ai_tagging_*: routes each file into a
  // user-named topic folder under the date hierarchy (…/Y/M/D/<category>/).
  categorize_enabled: boolean;
  categorize_categories: string[];
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

export interface Rule {
  id: string;
  name: string;
  condition: Record<string, unknown>;
  tag: string;
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
    | "duplicate_unknown";
  file_size?: number;
  /** Why the junk filter quarantined this file (junk status only). */
  quarantine_reason?: string | null;
  duplicate_type?: "exact" | "perceptual" | null;
  duplicate_similarity?: number | null;
  duplicate_of?: string | null;
  duplicate_evaluation?: "known" | "unknown";
  duplicate_unknown_reason?: "video_perceptual_not_computed" | null;
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
}

export interface PreviewResult {
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
  };
  partial: boolean;
  issues: Array<Record<string, unknown>>;
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

  async startSort(dryRun = false, idempotencyKey?: string): Promise<string> {
    return this.startTask("/api/sorting/start", { dry_run: dryRun }, idempotencyKey);
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
