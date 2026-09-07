// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EnrichGroup } from "@/components/config/groups/EnrichGroup";
import { I18nProvider } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { INVENTED_SAMPLES } from "@/lib/configSummary";
import type { HardwareInfo } from "@/types/api";

const probe = vi.hoisted(() => ({
  hardware: undefined as HardwareInfo | undefined,
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));
vi.mock("@/hooks/useHardware", () => ({ useHardware: () => probe }));
vi.mock("@/hooks/useAiModels", () => ({
  useAiModels: () => ({ inventory: { required_pack_id: "siglip-standard-v1", packs: [] } }),
}));
vi.mock("@/components/config/fields/AiModelManager", () => ({
  AiModelManager: () => <section aria-label="Local AI model files">Not installed</section>,
}));

afterEach(cleanup);
beforeEach(() => {
  probe.hardware = {
    logical_cpus: 8,
    total_ram_gb: 16,
    has_accelerator: true,
    recommended_tier: "standard",
    onnx_providers: ["CoreMLExecutionProvider"],
  };
  probe.error = null;
  probe.refetch.mockClear();
});

it("offers shared model setup without requiring tagging to be enabled", () => {
  const updateConfig = vi.fn();
  render(
    <I18nProvider initialLocale="en">
      <EnrichGroup
        config={{ ...TEST_CONFIG, ai_tagging_enabled: false }}
        updateConfig={updateConfig}
        fieldErrors={new Map()}
        samples={INVENTED_SAMPLES}
      />
    </I18nProvider>,
  );
  const model = screen.getByRole("combobox", { name: "Local AI model" });
  expect(screen.getByRole("region", { name: "Local AI model files" })).toBeTruthy();
  expect(screen.getByLabelText("Use GPU acceleration")).toBeTruthy();
  fireEvent.change(model, { target: { value: "off" } });
  expect(updateConfig).toHaveBeenCalledWith({ ai_model_tier: "off" });
  fireEvent.change(model, { target: { value: "auto" } });
  expect(updateConfig).toHaveBeenLastCalledWith({ ai_model_tier: "auto" });
  expect(updateConfig).not.toHaveBeenCalledWith({ ai_tagging_enabled: true });
});

it("offers a retry when hardware detection fails instead of claiming it is still checking", () => {
  probe.hardware = undefined;
  probe.error = new Error("Offline");
  render(
    <I18nProvider initialLocale="en">
      <EnrichGroup
        config={TEST_CONFIG}
        updateConfig={vi.fn()}
        fieldErrors={new Map()}
        samples={INVENTED_SAMPLES}
      />
    </I18nProvider>,
  );
  expect(screen.getByRole("alert").textContent).toContain("Could not detect local AI hardware");
  expect(screen.queryByText("Checking local model files…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(probe.refetch).toHaveBeenCalledOnce();
});
