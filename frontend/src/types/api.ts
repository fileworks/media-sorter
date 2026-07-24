// Re-export everything from the API client so consumers only need one import.
export type {
  Config,
  AiModelTier,
  HardwareInfo,
  ConfigSectionMeta,
  ConfigIssue,
  ValidateConfigResult,
  Rule,
  DiskSpaceResult,
  TaskProgress,
  TaskEvent,
  TaskFailure,
  TaskStatus,
  SortingStatus,
  PreviewItem,
  PreviewResult,
  PreviewStatus,
  MediaInfo,
  AnalysisResult,
  AnalysisStatus,
  ScanStatus,
  ApiError,
  HealthResponse,
  FileOperationRecord,
  OperationReport,
  OperationListItem,
  OperationListResponse,
} from "@/services/api";

// ── Extended types ─────────────────────────────────────────────────────────────

/**
 * Task result payload (from GET /api/sorting/{task_id} once completed).
 * This is the flat stats dict; use OperationReport for detailed data.
 */
export interface SortTaskResult {
  total: number;
  sorted: number;
  failed: number;
  skipped: number;
  duplicates: number;
  future_dates: number;
  unknown_dates: number;
  corrupted: number;
  /** Junk/thumbnail files quarantined to _junk/ (0 when the filter is off). */
  junk?: number;
  /** Files skipped because they already exist in the destination (0 when off). */
  already_in_destination?: number;
  operation_id: string;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warning" | "error" | "critical";
  message: string;
  context?: Record<string, unknown>;
  type?: string;
}
