// @vitest-environment jsdom

/**
 * The Review surface's real behaviours, driven through the rendered screen.
 *
 * The row model is unit-tested next door; what was untested is that the screen
 * actually wires it up — that a shift-click reaches the range logic with the
 * visible order it was filtered into, that excluding one half of a RAW+JPEG
 * pair takes the pair, and that the chip, the search box and the tree compose
 * rather than replace one another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { I18nProvider } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { api } from "@/services/api";
import type { Config, PreviewItem, PreviewResult } from "@/types/api";

function item(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    source: "/in/photo.jpg",
    destination: "/out/2025/07/photo.jpg",
    extracted_date: "2025-07-04",
    metadata_source: "exif",
    tags: [],
    status: "sort",
    file_size: 1000,
    ...overrides,
  } as PreviewItem;
}

/** Stats derived from the items, so the fixture cannot disagree with itself. */
function previewResult(...items: PreviewItem[]): PreviewResult {
  const count = (status: PreviewItem["status"]) =>
    items.filter((entry) => entry.status === status).length;
  return {
    config_fingerprint: "test",
    plan_id: "plan_test",
    impact: {
      actionable_groups: items.length,
      copy_count: count("sort"),
      move_count: 0,
      quarantine_count: count("junk"),
      quarantine_bytes: 0,
      skip_count: 0,
      source_mutations: 0,
      required_bytes: 0,
      conversion_without_originals: 0,
      companions_left_in_place: 0,
      embedded_tag_count: 0,
      unresolved_count: 0,
    },
    items,
    stats: {
      total: items.length,
      will_sort: count("sort"),
      will_fail: count("failed"),
      will_quarantine_unknown: count("unknown_date"),
      will_quarantine_future: count("future_date"),
      will_skip_duplicate: count("duplicate"),
      will_quarantine_junk: count("junk"),
      will_skip_already_in_destination: count("already_in_destination"),
      uncategorized: 0,
    },
    partial: false,
    issues: [],
  } as unknown as PreviewResult;
}

let decisions: { excludedSources: string[] } = { excludedSources: [] };

function renderReview(result: PreviewResult, config: Config = TEST_CONFIG) {
  decisions = { excludedSources: [] };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ReviewScreen
          result={result}
          config={config}
          onSelectView={() => {}}
          onOpenSetting={() => {}}
          onRerunPreview={() => {}}
          onDecisionsChange={(next) => {
            decisions = next;
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The file-name checkbox for a row, which is how the list exposes selection. */
function rowCheckbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

/** Chips name themselves "<label>, <n> files", which is also what they show. */
function chip(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${label}, \\d+ files$`) });
}

beforeEach(() => {
  // jsdom has no ResizeObserver, which the list's virtual window measures with.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, "listReviewGroups").mockResolvedValue({
    groups: [],
    next_cursor: null,
    kind: "exact",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shift-click range selection", () => {
  const result = previewResult(
    item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
    item({ source: "/in/b.jpg", destination: "/out/2025/07/b.jpg" }),
    item({ source: "/in/c.jpg", destination: "/out/2025/07/c.jpg" }),
    item({ source: "/in/d.jpg", destination: "/out/2025/07/d.jpg" }),
  );

  it("selects everything between the two clicks", () => {
    renderReview(result);

    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.click(rowCheckbox("d.jpg"), { shiftKey: true });

    for (const name of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) {
      expect(rowCheckbox(name).checked).toBe(true);
    }
  });

  it("extends backwards from the anchor just as well", () => {
    renderReview(result);

    fireEvent.click(rowCheckbox("d.jpg"));
    fireEvent.click(rowCheckbox("b.jpg"), { shiftKey: true });

    expect(rowCheckbox("a.jpg").checked).toBe(false);
    for (const name of ["b.jpg", "c.jpg", "d.jpg"]) {
      expect(rowCheckbox(name).checked).toBe(true);
    }
  });

  it("ranges over what is visible, not over the whole plan", () => {
    // A range you cannot see is a range you did not mean: with the list
    // narrowed to two files, the shift-click must not sweep up the one the
    // filter is hiding between them.
    renderReview(result);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a.jpg" } });
    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });

    fireEvent.click(rowCheckbox("c.jpg"), { shiftKey: true });

    expect(rowCheckbox("b.jpg").checked).toBe(true);
  });
});

describe("excluding a file expands to its whole media unit", () => {
  const result = previewResult(
    item({
      source: "/in/shot.raw",
      destination: "/out/2025/07/shot.raw",
      unit_id: "unit-1",
      unit_primary: true,
    }),
    item({
      source: "/in/shot.jpg",
      destination: "/out/2025/07/shot.jpg",
      unit_id: "unit-1",
      unit_primary: false,
    }),
    item({ source: "/in/other.jpg", destination: "/out/2025/07/other.jpg" }),
  );

  it("takes the RAW with the JPEG rather than splitting the pair", () => {
    renderReview(result);

    fireEvent.click(rowCheckbox("shot.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Exclude from this run" }));

    expect(decisions.excludedSources.sort()).toEqual(["/in/shot.jpg", "/in/shot.raw"]);
  });

  it("leaves a file outside the unit alone", () => {
    renderReview(result);

    fireEvent.click(rowCheckbox("other.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Exclude from this run" }));

    expect(decisions.excludedSources).toEqual(["/in/other.jpg"]);
  });

  it("puts the whole unit back too", () => {
    renderReview(result);

    fireEvent.click(rowCheckbox("shot.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Exclude from this run" }));
    fireEvent.click(rowCheckbox("shot.raw"));
    fireEvent.click(screen.getByRole("button", { name: "Include again" }));

    expect(decisions.excludedSources).toEqual([]);
  });
});

describe("the chip, the search box and the tree compose", () => {
  const result = previewResult(
    item({ source: "/in/holiday.jpg", destination: "/out/2025/07/holiday.jpg" }),
    item({ source: "/in/holiday-2.jpg", destination: "/out/2025/08/holiday-2.jpg" }),
    item({
      source: "/in/screenshot.png",
      destination: "/out/_junk/screenshot.png",
      status: "junk",
    }),
    item({
      source: "/in/holiday-junk.png",
      destination: "/out/_junk/holiday-junk.png",
      status: "junk",
    }),
  );

  it("narrows with AND rather than replacing the previous filter", () => {
    renderReview(result);

    // Chip alone: both junk files.
    fireEvent.click(chip("Junk"));
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();
    expect(rowCheckbox("screenshot.png")).toBeTruthy();
    expect(rowCheckbox("holiday-junk.png")).toBeTruthy();

    // Chip AND search: only the junk file whose name matches.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "holiday" } });
    expect(screen.queryByRole("checkbox", { name: "screenshot.png" })).toBeNull();
    expect(rowCheckbox("holiday-junk.png")).toBeTruthy();
  });

  it("keeps the tree selection when a chip changes", () => {
    renderReview(result);

    fireEvent.click(screen.getByRole("button", { name: "_junk" }));
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();

    // Now add a chip that cannot match anything inside that folder.
    fireEvent.click(chip("Organise"));
    expect(screen.queryByRole("checkbox", { name: "holiday-junk.png" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("counts a chip from the same rows the list draws", () => {
    renderReview(result);

    expect(chip("Junk").getAttribute("aria-label")).toBe("Junk, 2 files");
    fireEvent.click(chip("Junk"));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});
