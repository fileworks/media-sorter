import type { SortingStatus } from "@/types/api";

export function hasPersistedTerminalReport(status: SortingStatus["status"] | "idle"): boolean {
  return status === "completed" || status === "cancelled";
}

export function terminalOperationId(
  status: Pick<SortingStatus, "status" | "result">,
): string | null {
  if (!hasPersistedTerminalReport(status.status)) return null;
  return typeof status.result?.operation_id === "string" ? status.result.operation_id : null;
}

/** Retrying is safe only when execution never acquired a backend task. */
export function canRetryExecutionStart(
  status: SortingStatus["status"] | "idle",
  taskId: string | null,
): boolean {
  return status === "failed" && taskId === null;
}
