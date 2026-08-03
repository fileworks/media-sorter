// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiModelManager } from "@/components/config/fields/AiModelManager";
import { I18nProvider } from "@/i18n/I18nContext";
import { api, type AiModelInventory } from "@/services/api";

const PACK = {
  pack_id: "clip-lite-v1",
  model_id: "clip-vit-b-32",
  display_name: "CLIP Lite",
  state: "not_installed" as const,
  total_size: 608_015_951,
  installed_size: 0,
  license: "MIT",
  license_url: "https://example.test/license",
  source: "https://huggingface.co",
  task_id: null,
  error: null,
};

function inventory(state: "not_installed" | "ready"): AiModelInventory {
  return {
    effective_tier: "lite",
    required_pack_id: PACK.pack_id,
    packs: [
      {
        ...PACK,
        state,
        installed_size: state === "ready" ? PACK.total_size : 0,
      },
    ],
  };
}

function renderManager() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <AiModelManager />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AiModelManager", () => {
  it("shows the measured pack metadata and starts only an explicit install", async () => {
    vi.spyOn(api, "getAiModels").mockResolvedValue(inventory("not_installed"));
    const install = vi.spyOn(api, "installAiModel").mockResolvedValue("task-1");
    vi.spyOn(api, "getAiModelTask").mockResolvedValue({
      task_id: "task-1",
      operation_kind: "model_download",
      status: "running",
      progress: {
        current: 10,
        total: PACK.total_size,
        percentage: 10,
        phase: "downloading_model",
        bytes_done: 60_801_595,
        bytes_total: PACK.total_size,
      },
      partial: false,
      issues: [],
      events: [],
      last_event_sequence: 0,
      error: null,
      failure: null,
      result: null,
    });

    const view = renderManager();
    const region = await view.findByRole("region", { name: "Local AI model files" });

    expect(within(region).getByText("CLIP Lite")).toBeTruthy();
    expect(within(region).getByText("580 MB", { exact: false })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(within(region).getByRole("button", { name: "Install model" }));

    await waitFor(() => expect(install).toHaveBeenCalledWith("clip-lite-v1"));
    await view.findByRole("progressbar");
  });

  it("requires a second action before removing verified files", async () => {
    vi.spyOn(api, "getAiModels").mockResolvedValue(inventory("ready"));
    const remove = vi
      .spyOn(api, "removeAiModel")
      .mockResolvedValue({ ...PACK, state: "not_installed" });

    const view = renderManager();
    const region = await view.findByRole("region", { name: "Local AI model files" });
    expect(within(region).getByText("Ready offline")).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "Remove files" }));
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(within(region).getByRole("button", { name: "Remove model files" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("clip-lite-v1"));
  });
});
