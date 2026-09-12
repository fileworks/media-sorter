// @vitest-environment jsdom

/**
 * A folder card states what is in *that* folder.
 *
 * It used to state what was in the run. The scan produced one aggregate and
 * there were several input cards to put it on, so the totals landed on the
 * first card — "190 files · 264 MB · png 74 · heic 2" — and every other input
 * card printed the same run-wide number in a different shape: "190 files
 * indexed · Included in this run's scan and plan". Two presentations of one
 * figure, on two folders, each reading as a fact about the folder it was on.
 * The reasonable conclusion from that pair of cards is that the second folder
 * holds no media, and it is wrong.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { I18nProvider } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import type { RootCard } from "@/lib/sourcesStage";
import type { AnalysisResult } from "@/types/api";

const HOLIDAY: RootCard = {
  rootId: "root-holiday",
  role: "input",
  path: "/Volumes/Photos/Holiday",
  displayName: null,
  priority: 0,
  exclusions: [],
  state: "ready",
  volume: null,
  freshness: "fresh",
  indexedFiles: 190,
  issueCount: 0,
};

const ARCHIVE: RootCard = {
  ...HOLIDAY,
  rootId: "root-archive",
  path: "/Volumes/Photos/Archive",
  priority: 1,
  indexedFiles: 12,
};

const DESTINATION: RootCard = {
  ...HOLIDAY,
  rootId: "root-destination",
  role: "destination",
  path: "/Volumes/Archive/Sorted",
};

function analysis(byRoot: AnalysisResult["by_root"]): AnalysisResult {
  return {
    total_files: 202,
    total_size_bytes: 300_000_000,
    by_type: { png: 74, heic: 2, jpeg: 126 },
    by_root: byRoot,
    disk_space: {
      destination_free_bytes: 900_000_000_000,
      source_size_bytes: 300_000_000,
      free_space_known: true,
    },
  } as unknown as AnalysisResult;
}

function renderSources(result: AnalysisResult, cards: RootCard[]) {
  return render(
    <I18nProvider initialLocale="en">
      <SourcesScreen
        cards={cards}
        excludedForRun={[]}
        analysis={result}
        config={TEST_CONFIG}
        onChange={() => undefined}
        onExcludeForRun={() => undefined}
        onAddFolder={() => undefined}
        onChangeFolder={() => undefined}
        onRemove={() => undefined}
      />
    </I18nProvider>,
  );
}

function cardFor(path: string): HTMLElement {
  const card = screen.getAllByTitle(path)[0].closest("li");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

afterEach(cleanup);

describe("input folder facts", () => {
  it("gives each input folder its own count, size and kinds", () => {
    renderSources(
      analysis([
        {
          root_id: "root-holiday",
          path: HOLIDAY.path,
          total_files: 190,
          total_size_bytes: 264_000_000,
          by_type: { png: 74, heic: 2, jpeg: 114 },
        },
        {
          root_id: "root-archive",
          path: ARCHIVE.path,
          total_files: 12,
          total_size_bytes: 36_000_000,
          by_type: { jpeg: 12 },
        },
      ]),
      [HOLIDAY, ARCHIVE, DESTINATION],
    );

    // Neither card claims the other's files, and neither claims the run's 202.
    expect(within(cardFor(HOLIDAY.path)).getByText(/^190 files · /)).toBeTruthy();
    expect(within(cardFor(ARCHIVE.path)).getByText(/^12 files · /)).toBeTruthy();
    expect(within(cardFor(ARCHIVE.path)).queryByText(/202 files/)).toBeNull();

    // Both cards report kinds, so the second is no longer the one that looks
    // like it holds nothing.
    expect(within(cardFor(HOLIDAY.path)).getByText(/png 74/)).toBeTruthy();
    expect(within(cardFor(ARCHIVE.path)).getByText(/jpeg 12/)).toBeTruthy();
  });

  it("says a folder is empty rather than borrowing its neighbour's total", () => {
    renderSources(
      analysis([
        {
          root_id: "root-holiday",
          path: HOLIDAY.path,
          total_files: 202,
          total_size_bytes: 300_000_000,
          by_type: { jpeg: 202 },
        },
        {
          root_id: "root-archive",
          path: ARCHIVE.path,
          total_files: 0,
          total_size_bytes: 0,
          by_type: {},
        },
      ]),
      [HOLIDAY, ARCHIVE, DESTINATION],
    );

    // Facts are joined into one line with the trailing full stops trimmed.
    expect(
      within(cardFor(ARCHIVE.path)).getByText(/^No media found in this folder · /),
    ).toBeTruthy();
    expect(within(cardFor(ARCHIVE.path)).queryByText(/202 files/)).toBeNull();
  });

  it("labels the aggregate as run-wide when a result carries no per-folder split", () => {
    // A plan recovered from a backend that predates `by_root`. The figure is
    // still true of the run, so it is shown — said as a fact about the run.
    renderSources(analysis(undefined), [HOLIDAY, ARCHIVE, DESTINATION]);

    expect(
      within(cardFor(HOLIDAY.path)).getByText(/202 files across every input folder/),
    ).toBeTruthy();
    expect(
      within(cardFor(ARCHIVE.path)).getByText(/Counted with the other input folders$/),
    ).toBeTruthy();
    expect(within(cardFor(ARCHIVE.path)).queryByText(/202 files indexed/)).toBeNull();
  });
});
