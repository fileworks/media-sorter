import { useEffect, useRef, useState } from "react";
import type { useAnalysis } from "@/hooks/useAnalysis";
import type { usePreview } from "@/hooks/usePreview";
import type { useSorting } from "@/hooks/useSorting";
import type { DiagnosticsResponse } from "@/services/api";

/** Reattach backend-owned work and settle its first snapshot before startup opens. */
export function useInitialProgressRestoration({
  diagnosticsReady,
  activeTask,
  analysis,
  preview,
  sorting,
  onRecoveredStage,
}: {
  diagnosticsReady: boolean;
  activeTask: DiagnosticsResponse["active_task"];
  analysis: ReturnType<typeof useAnalysis>;
  preview: ReturnType<typeof usePreview>;
  sorting: ReturnType<typeof useSorting>;
  onRecoveredStage: (stage: "review" | "execute") => void;
}): boolean {
  const resumedTaskRef = useRef<string | null>(null);
  const [restored, setRestored] = useState(false);
  const isSorting = sorting.status === "running" || sorting.status === "pending";

  useEffect(() => {
    // Completed-plan recovery must settle before live work replaces that plan.
    if (!preview.rehydrated) return;
    if (!activeTask) {
      resumedTaskRef.current = null;
      return;
    }
    if (
      resumedTaskRef.current === activeTask.task_id ||
      analysis.taskId === activeTask.task_id ||
      preview.taskId === activeTask.task_id ||
      sorting.taskId === activeTask.task_id ||
      analysis.loading ||
      preview.loading ||
      isSorting
    ) {
      return;
    }
    if (activeTask.operation_kind === "analysis") {
      resumedTaskRef.current = activeTask.task_id;
      analysis.resumeAnalysis(activeTask.task_id);
      onRecoveredStage("review");
    } else if (activeTask.operation_kind === "preview") {
      resumedTaskRef.current = activeTask.task_id;
      preview.resumePreview(activeTask.task_id);
      onRecoveredStage("review");
    } else if (activeTask.operation_kind === "sort") {
      resumedTaskRef.current = activeTask.task_id;
      sorting.resumeSorting(activeTask.task_id, activeTask.status);
      onRecoveredStage("execute");
    }
  }, [activeTask, analysis, isSorting, onRecoveredStage, preview, sorting]);

  const taskRestored =
    !activeTask ||
    !["analysis", "preview", "sort"].includes(activeTask.operation_kind) ||
    (activeTask.operation_kind === "analysis" &&
      analysis.taskId === activeTask.task_id &&
      analysis.statusSettled) ||
    (activeTask.operation_kind === "preview" &&
      preview.taskId === activeTask.task_id &&
      preview.statusSettled) ||
    (activeTask.operation_kind === "sort" &&
      sorting.taskId === activeTask.task_id &&
      sorting.statusSettled);

  // Runs after recovered navigation and reattachment effects. Latch once so
  // subsequent polling cannot replace the workflow with the loading screen.
  useEffect(() => {
    if (preview.rehydrated && diagnosticsReady && taskRestored) setRestored(true);
  }, [diagnosticsReady, preview.rehydrated, taskRestored]);

  return restored;
}
