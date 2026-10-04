// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/I18nContext";
import { useConfig } from "@/hooks/useConfig";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { api, type Config, type UpdateInfo } from "@/services/api";

const info: UpdateInfo = {
  current_version: "1.0.0",
  latest_version: "1.1.0",
  update_available: true,
  release_url: "https://github.com/fileworks/media-sorter/releases/tag/v1.1.0",
  release_notes: null,
  published_at: null,
  checked_at: "2026-10-04",
  asset_url: null,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{children}</I18nProvider>
    </QueryClientProvider>
  );
}

describe("automatic update checks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for opt-in/config and hides cached results when disabled", async () => {
    const check = vi.spyOn(api, "checkUpdate").mockResolvedValue(info);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ enabled }) => useUpdateCheck(enabled), {
      wrapper: wrapper(client),
      initialProps: { enabled: false },
    });
    expect(check).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data?.update_available).toBe(true));
    rerender({ enabled: false });
    expect(result.current.data).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks again immediately after the persisted setting is re-enabled", async () => {
    const config = { update_check_enabled: true } as Config;
    vi.spyOn(api, "getConfig").mockResolvedValue(config);
    vi.spyOn(api, "validateConfig").mockResolvedValue({ errors: [], warnings: [], valid: true });
    vi.spyOn(api, "saveConfig").mockImplementation(async (patch) => ({ ...config, ...patch }));
    const check = vi.spyOn(api, "checkUpdate").mockResolvedValue(info);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => {
        const settings = useConfig();
        const update = useUpdateCheck(settings.config?.update_check_enabled === true);
        return { ...settings, update };
      },
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    act(() => result.current.updateConfig({ update_check_enabled: false }));
    await waitFor(() => expect(result.current.config?.update_check_enabled).toBe(false));
    expect(result.current.update.data).toBeUndefined();
    act(() => result.current.updateConfig({ update_check_enabled: true }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  });
});
