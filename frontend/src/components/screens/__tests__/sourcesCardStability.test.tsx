// @vitest-environment jsdom

/**
 * A folder card spends no empty line on a status it does not have.
 *
 * Skipping a folder for a run used to insert a line, and marking one as a
 * baseline swapped a one-line facts block for a two-line one, so the cards
 * below jumped by a line each time — while the pointer was still over the
 * control that caused it. Status now lives in the title row, which every card
 * already owns; only a real conflict is allowed to add a sentence and height.
 *
 * jsdom has no layout, so height is asserted structurally: the same paragraphs
 * in the same block, in the same number, before and after. A
 * `getBoundingClientRect` of 0 would assert nothing. Both locales are checked
 * because German is the longer one and a chip sized to English can wrap in it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import type { RootCard } from "@/lib/sourcesStage";
import type { AnalysisResult } from "@/types/api";

type Locale = "en" | "de";

const INPUT: RootCard = {
  rootId: "root-input",
  role: "input",
  path: "/Volumes/Photos/Camera",
  displayName: null,
  priority: 0,
  exclusions: [],
  state: "ready",
  volume: null,
  freshness: "fresh",
  indexedFiles: 1200,
  issueCount: 0,
};

const DESTINATION: RootCard = {
  ...INPUT,
  rootId: "root-destination",
  role: "destination",
  path: "/Volumes/Archive/Sorted",
};

const ANALYSIS = {
  total_files: 1200,
  total_size_bytes: 4_000_000_000,
  by_type: { image: 1000, video: 200 },
  disk_space: {
    destination_free_bytes: 900_000_000_000,
    source_size_bytes: 4_000_000_000,
    free_space_known: true,
  },
} as unknown as AnalysisResult;

afterEach(cleanup);

function renderSources(locale: Locale, cards: RootCard[], excludedForRun: string[] = []) {
  const onChange = (next: RootCard[]) => void next;
  return render(
    <I18nProvider initialLocale={locale}>
      <SourcesScreen
        cards={cards}
        excludedForRun={excludedForRun}
        analysis={ANALYSIS}
        config={TEST_CONFIG}
        onChange={onChange}
        onExcludeForRun={() => undefined}
        onAddFolder={() => undefined}
        onChangeFolder={() => undefined}
        onRemove={() => undefined}
      />
    </I18nProvider>,
  );
}

function inputCard(): HTMLElement {
  const card = screen.getAllByTitle(INPUT.path)[0].closest("li");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

function destinationCard(): HTMLElement {
  const card = screen.getAllByTitle(DESTINATION.path)[0].closest("li");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

/** Every paragraph a card renders — the thing that decides its height. */
function paragraphCount(card: HTMLElement): number {
  return within(card).getAllByText(/.*/, { selector: "p" }).length;
}

/** The input card's shape, which a toggle must never change. */
function cardShape(): number {
  return paragraphCount(inputCard());
}

describe.each<Locale>(["en", "de"])("folder card stability (%s)", (locale) => {
  it("keeps the card's line count across a skip toggle", () => {
    renderSources(locale, [INPUT, DESTINATION]);
    const before = cardShape();

    cleanup();
    renderSources(locale, [INPUT, DESTINATION], [INPUT.rootId]);

    expect(cardShape()).toBe(before);
    const chip = within(inputCard()).getByText(translate(locale, "sources.excludedThisRun"));
    expect(chip.tagName).toBe("SPAN");
    expect(chip.parentElement?.parentElement?.querySelector("p")?.textContent).toContain("Camera");
  });

  it("keeps the card's line count when an input becomes a baseline", () => {
    renderSources(locale, [INPUT, DESTINATION]);
    const before = cardShape();

    cleanup();
    renderSources(locale, [{ ...INPUT, role: "reference" }, DESTINATION]);

    // A reference reports two facts where a secondary input reports one; the
    // padded block absorbs the difference.
    expect(cardShape()).toBe(before);
  });

  it("renders no empty paragraph while the card has no notice", () => {
    renderSources(locale, [INPUT, DESTINATION]);

    const empty = [...inputCard().querySelectorAll("p")].filter(
      (paragraph) => paragraph.textContent?.trim() === "",
    );
    expect(empty).toEqual([]);
    expect(inputCard().querySelector("[aria-hidden='true'] p")).toBeNull();
  });

  it("puts the input and destination actions at the same height", () => {
    renderSources(locale, [INPUT, DESTINATION]);

    // Both columns are read side by side, so their buttons have to line up
    // whatever each card has to say above them.
    expect(paragraphCount(destinationCard())).toBe(paragraphCount(inputCard()));
  });

  it("keeps them aligned before a scan has produced any figures", () => {
    cleanup();
    render(
      <I18nProvider initialLocale={locale}>
        <SourcesScreen
          cards={[INPUT, DESTINATION]}
          excludedForRun={[]}
          analysis={null}
          config={TEST_CONFIG}
          onChange={() => undefined}
          onExcludeForRun={() => undefined}
          onAddFolder={() => undefined}
          onChangeFolder={() => undefined}
          onRemove={() => undefined}
        />
      </I18nProvider>,
    );

    expect(paragraphCount(destinationCard())).toBe(paragraphCount(inputCard()));
  });

  it("lets only a real conflict add a full sentence", () => {
    renderSources(locale, [INPUT, DESTINATION]);
    const ordinary = paragraphCount(inputCard());

    cleanup();
    renderSources(locale, [INPUT, { ...DESTINATION, path: `${INPUT.path}/Sorted` }]);

    const card = inputCard();
    expect(within(card).getByText(translate(locale, "sources.conflictChip"))).toBeTruthy();
    expect(paragraphCount(card)).toBeGreaterThan(ordinary);
  });
});

describe("a conflicting role change explains itself under its own card", () => {
  it("puts the panel inside the card whose role was changed", () => {
    // A destination nested inside the input is a blocking conflict, so asking
    // for the input to become a baseline has to be confirmed.
    const nested: RootCard = { ...DESTINATION, path: `${INPUT.path}/Sorted` };
    renderSources("en", [INPUT, nested]);

    fireEvent.click(screen.getByRole("checkbox", { name: /baseline/i }));

    const panel = screen
      .getAllByRole("alert")
      .find((node) => node.textContent?.includes(translate("en", "sources.roleChangeConflict")));
    expect(panel).toBeTruthy();
    expect(inputCard().contains(panel as HTMLElement)).toBe(true);
  });
});
