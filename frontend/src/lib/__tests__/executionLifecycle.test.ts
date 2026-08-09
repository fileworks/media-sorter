import { describe, expect, it } from "vitest";

import {
  canRetryExecutionStart,
  hasPersistedTerminalReport,
  terminalOperationId,
} from "@/lib/executionLifecycle";
import type { SortingStatus } from "@/types/api";

function status(state: SortingStatus["status"], operationId?: string) {
  return {
    status: state,
    result: operationId ? { operation_id: operationId } : null,
  };
}

describe("execution terminal lifecycle", () => {
  it("loads persisted reports for both completed and cancelled runs", () => {
    expect(hasPersistedTerminalReport("completed")).toBe(true);
    expect(hasPersistedTerminalReport("cancelled")).toBe(true);
    expect(terminalOperationId(status("cancelled", "sort-1"))).toBe("sort-1");
  });

  it("does not invent a report for a failed task without a persisted result", () => {
    expect(hasPersistedTerminalReport("failed")).toBe(false);
    expect(terminalOperationId(status("failed", "sort-1"))).toBeNull();
  });

  it("offers execution retry only when starting failed before a task existed", () => {
    expect(canRetryExecutionStart("failed", null)).toBe(true);
    expect(canRetryExecutionStart("failed", "partially-applied-task")).toBe(false);
    expect(canRetryExecutionStart("cancelled", null)).toBe(false);
  });
});
