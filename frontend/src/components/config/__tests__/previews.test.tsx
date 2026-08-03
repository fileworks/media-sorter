// @vitest-environment jsdom

/**
 * The two Configure previews, asserted against what the backend actually does.
 *
 * Both used to describe their result rather than show it: the folder preview
 * was one line about an invented file, rendered above half the rows that
 * decide it, and the rename preview showed only the name that came out. The
 * point of each is now that it can be *read* against a real setting change,
 * which is what these tests exercise.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { FolderTreePreview } from "@/components/config/fields/FolderTreePreview";
import { RenameBuilder } from "@/components/config/fields/RenameBuilder";
import { I18nProvider } from "@/i18n/I18nContext";
import { INVENTED_SAMPLES } from "@/lib/configSummary";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import type { Config } from "@/types/api";

const ORGANIZE: Config = { ...TEST_CONFIG, run_mode: "organize", sort_criteria: ["year", "month"] };

function renderTree(config: Config) {
  return render(
    <I18nProvider initialLocale="en">
      <FolderTreePreview config={config} samples={INVENTED_SAMPLES} invented />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("folder tree preview", () => {
  it("draws the date hierarchy with the review folders as its siblings", () => {
    renderTree(ORGANIZE);

    expect(screen.getByText("2025/")).toBeTruthy();
    expect(screen.getByText("07 — July/")).toBeTruthy();
    expect(screen.getByText("_duplicates/")).toBeTruthy();

    // The review folder is a sibling of the year, not nested inside it: the
    // one thing about the layout people get wrong.
    const year = screen.getByText("2025/").closest("li");
    expect(year).not.toBeNull();
    expect(within(year as HTMLElement).queryByText("_duplicates/")).toBeNull();
  });

  it("follows each setting that feeds it", () => {
    const { rerender } = renderTree(ORGANIZE);
    expect(screen.queryByText("Pixel 9 Pro/")).toBeNull();

    rerender(
      <I18nProvider initialLocale="en">
        <FolderTreePreview
          config={{ ...ORGANIZE, camera_subfolder_enabled: true, rename: true }}
          samples={INVENTED_SAMPLES}
          invented
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Pixel 9 Pro/")).toBeTruthy();
    // TYPE_YYYY-MM-DD, the shipped pattern, applied to the sample.
    expect(screen.getByText("IMG_2025-07-14.JPG")).toBeTruthy();
  });

  it("shows only the review folders in deduplicate-only, and says why", () => {
    renderTree({ ...ORGANIZE, run_mode: "deduplicate_only" });

    expect(screen.queryByText("2025/")).toBeNull();
    expect(screen.getByText("_duplicates/")).toBeTruthy();
    expect(
      screen.getByText(/Everything else stays exactly where it is/),
    ).toBeTruthy();
  });

  it("omits a review folder the settings cannot produce", () => {
    renderTree({ ...ORGANIZE, remove_duplicates: false, junk_filter_enabled: false });

    expect(screen.queryByText("_duplicates/")).toBeNull();
    expect(screen.queryByText("_junk/")).toBeNull();
    expect(screen.getByText("_failed/")).toBeTruthy();
  });
});

describe("rename preview", () => {
  function renderRename(config: Partial<Config> = {}) {
    const onCommit = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <RenameBuilder
          config={{ ...ORGANIZE, rename: true, ...config }}
          samples={INVENTED_SAMPLES}
          onCommit={onCommit}
        />
      </I18nProvider>,
    );
    return onCommit;
  }

  it("shows what each name is now beside what it becomes", () => {
    renderRename({ rename_pattern: "YYYY-MM-DD_NAME" });

    const row = screen.getByText("IMG_4382.JPG").closest("tr");
    expect(row).not.toBeNull();
    expect((row as HTMLElement).textContent).toContain("2025-07-14_IMG_4382.JPG");
  });

  it("demonstrates the collision suffix when the pattern drops the original name", () => {
    renderRename({ rename_pattern: "TYPE_YYYY-MM-DD" });

    expect(screen.getByText("IMG_2025-07-14_001.JPG")).toBeTruthy();
    expect(screen.getByText("name already taken")).toBeTruthy();
  });

  it("does not claim a collision when every name stays distinct", () => {
    renderRename({ rename_pattern: "NAME_YYYY" });

    expect(screen.queryByText("name already taken")).toBeNull();
  });

  it("shows conversion rewriting the extension, and marks the row that converts", () => {
    renderRename({
      rename_pattern: "NAME",
      convert_images: true,
      image_format: "png",
    });

    const row = screen.getByText("IMG_4382.JPG").closest("tr");
    expect((row as HTMLElement).textContent).toContain("IMG_4382.png");
    expect(screen.getByText("converted")).toBeTruthy();
  });

  it("previews the pattern being typed, before it is committed", () => {
    const onCommit = renderRename({ rename_pattern: "NAME" });

    fireEvent.change(screen.getByDisplayValue("NAME"), { target: { value: "YYYY_NAME" } });

    expect(onCommit).toHaveBeenCalledWith("YYYY_NAME");
    const row = screen.getByText("IMG_4382.JPG").closest("tr");
    expect((row as HTMLElement).textContent).toContain("2025_IMG_4382.JPG");
  });
});
