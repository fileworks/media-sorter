import type { AnalysisResult, PreviewResult } from "@/services/api";

export interface AnalysisGate {
  canPreview: boolean;
  empty: boolean;
  reason: string | null;
}

/** Derive the preview gate from the last completed analysis. */
export function getAnalysisGate(
  result: AnalysisResult | null,
  loading: boolean,
  error: string | null,
): AnalysisGate {
  if (loading) {
    return { canPreview: false, empty: false, reason: "Wait for analysis to finish" };
  }
  if (error) {
    return { canPreview: false, empty: false, reason: "Analysis failed — retry first" };
  }
  if (result === null) {
    return { canPreview: false, empty: false, reason: "Run analysis first" };
  }
  if (result.total_files === 0) {
    return {
      canPreview: false,
      empty: true,
      reason: "No supported files matched the current scan settings",
    };
  }
  if (!result.disk_space.sufficient) {
    return {
      canPreview: false,
      empty: false,
      reason: "Analysis must complete with sufficient disk space",
    };
  }
  return { canPreview: true, empty: false, reason: null };
}

export function partialScanWarning(operation: string, issueCount: number): string {
  return `${operation} is partial: ${issueCount.toLocaleString()} inaccessible path(s) were skipped.`;
}

export function canStartSort(result: PreviewResult | null): boolean {
  return result !== null && result.stats.total > 0;
}
