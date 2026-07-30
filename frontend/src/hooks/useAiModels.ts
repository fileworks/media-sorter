import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { AiModelInventory } from "@/types/api";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export function useAiModels() {
  const queryClient = useQueryClient();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const inventory = useQuery<AiModelInventory>({
    queryKey: ["ai-models"],
    queryFn: () => api.getAiModels(),
    staleTime: 2_000,
    refetchInterval: (query) =>
      query.state.data?.packs.some((pack) => pack.state === "downloading") ? 750 : false,
  });

  const task = useQuery({
    queryKey: ["ai-model-task", activeTaskId],
    queryFn: () => api.getAiModelTask(activeTaskId!),
    enabled: activeTaskId !== null,
    refetchInterval: (query) =>
      query.state.data && TERMINAL_STATES.has(query.state.data.status) ? false : 500,
  });

  useEffect(() => {
    if (!task.data || !TERMINAL_STATES.has(task.data.status)) return;
    void queryClient.invalidateQueries({ queryKey: ["ai-models"] });
  }, [queryClient, task.data]);

  useEffect(() => {
    if (activeTaskId || !inventory.data) return;
    const running = inventory.data.packs.find(
      (pack) => pack.state === "downloading" && pack.task_id,
    );
    if (running?.task_id) setActiveTaskId(running.task_id);
  }, [activeTaskId, inventory.data]);

  const install = useMutation({
    mutationFn: (packId: string) => api.installAiModel(packId),
    onSuccess: (taskId) => {
      setActiveTaskId(taskId);
      void queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    },
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) => api.cancelAiModelInstall(taskId),
    onSuccess: () => {
      void task.refetch();
      void queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    },
  });

  const remove = useMutation({
    mutationFn: (packId: string) => api.removeAiModel(packId),
    onSuccess: () => {
      setActiveTaskId(null);
      void queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    },
  });

  return {
    inventory: inventory.data,
    isLoading: inventory.isLoading,
    inventoryError: inventory.error,
    task: task.data,
    activeTaskId,
    install,
    cancel,
    remove,
  };
}
