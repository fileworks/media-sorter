// @vitest-environment jsdom

/**
 * A setting that has been moved says so, and offers the way back.
 *
 * The marker is only trustworthy if it is driven by the backend's own defaults
 * and by the field a row actually writes — a row that does not declare its
 * field cannot be marked, and a row marked for a field it does not write would
 * revert the wrong setting. Both halves are asserted here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConfigureScreen } from "@/components/screens/ConfigureScreen";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { api } from "@/services/api";
import type { Config } from "@/types/api";

const CHANGED_CONFIG: Config = {
  ...TEST_CONFIG,
  // Three deliberate deviations, one per group, covering a boolean, a scalar
  // and a row that declares two fields as one decision.
  copy_instead_of_move: true,
  duplicate_perceptual_threshold: 80,
  min_file_size_kb: 64,
};

function markerName(value: string): string {
  return translate("en", "config.changed.revert", { value });
}

function renderConfigure(overrides: Partial<Parameters<typeof ConfigureScreen>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <ConfigureScreen
          onSaveConfig={() => undefined}
          onSaveRecipe={async () => undefined}
          savedRecipes={[]}
          onApplyConfig={() => undefined}
          onDeleteRecipe={() => undefined}
          {...overrides}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, "getConfig").mockResolvedValue(CHANGED_CONFIG);
  vi.spyOn(api, "getConfigDefaults").mockResolvedValue(TEST_CONFIG);
  vi.spyOn(api, "getConfigSections").mockResolvedValue([]);
  vi.spyOn(api, "validateConfig").mockResolvedValue({ valid: true, errors: [], warnings: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("per-row changed markers", () => {
  it("marks exactly the rows whose fields deviate, naming each default", async () => {
    renderConfigure();
    await screen.findByRole("heading", { name: translate("en", "config.group.sort.label") });

    // Copy/Move defaults to move, so the marker states "Off" — the default of
    // `copy_instead_of_move`, not the label of the option now selected.
    expect(screen.getByRole("button", { name: markerName("Off") })).toBeTruthy();
    expect(screen.getByRole("button", { name: markerName("95") })).toBeTruthy();

    // The size-range row declares two fields; only the one that moved is named.
    expect(
      screen.getByRole("button", {
        name: markerName("Min file size (KB): Not set"),
      }),
    ).toBeTruthy();

    // One marker per deviation and no more: a row at its default is unmarked.
    const markers = screen
      .getAllByRole("button")
      .filter((button) =>
        button.getAttribute("aria-label")?.startsWith("Changed from the default"),
      );
    expect(markers).toHaveLength(3);
  });

  it("reverting one row asks first, listing only that setting", async () => {
    const onSaveConfig = vi.fn();
    renderConfigure({ onSaveConfig });
    await screen.findByRole("heading", { name: translate("en", "config.group.sort.label") });

    fireEvent.click(screen.getByRole("button", { name: markerName("95") }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(translate("en", "config.reset.rowTitle"))).toBeTruthy();
    expect(within(dialog).getAllByRole("row")).toHaveLength(2); // header + one setting
    expect(within(dialog).getByText("Similarity threshold")).toBeTruthy();
    expect(onSaveConfig).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: translate("en", "config.reset.confirm", { count: 1 }),
      }),
    );
    expect(onSaveConfig).toHaveBeenCalledWith({ duplicate_perceptual_threshold: 95 });
  });

  it("keeps the marker but withdraws the control while settings are locked", async () => {
    renderConfigure({ disabled: true });
    await screen.findByRole("heading", { name: translate("en", "config.group.sort.label") });

    expect(screen.queryByRole("button", { name: markerName("Off") })).toBeNull();
    expect(
      screen.getAllByLabelText(translate("en", "config.changed.marker")).length,
    ).toBeGreaterThan(0);
  });
});
