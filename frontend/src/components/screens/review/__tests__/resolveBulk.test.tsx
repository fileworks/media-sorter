// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ResolveQueue } from "@/components/screens/review/ResolveQueue";
import { I18nProvider } from "@/i18n/I18nContext";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

vi.mock("@/components/ui/thumbnail", () => ({
  Thumbnail: ({ path }: { path: string }) => <div data-path={path} />,
}));

function setEntry(
  id: string,
  sources = [`/source-a/${id}.jpg`, `/source-b/${id}.jpg`],
  setKind: SetEntry["setKind"] = "exact",
  origin: SetEntry["origin"] = "catalog",
): SetEntry {
  const rows = sources.map((source, index): ReviewRow => {
    const name = source.split("/").pop() ?? source;
    return {
      source,
      name,
      folder: source.slice(0, -(name.length + 1)),
      destination: `/out/${name}`,
      wouldBeDestination: `/out/${name}`,
      status: index === 0 ? "organize" : "duplicate",
      flags: [],
      sizeBytes: 1000 + index,
      date: null,
      dateSource: "none",
      category: null,
      tags: [],
      unitId: null,
      unitPrimary: true,
      companionCount: 0,
      provenance: null,
      stack: {
        id,
        kind: setKind,
        memberId: `${id}:${index}`,
        size: sources.length,
        isKeeper: index === 0,
        keptInstead: index === 0 ? null : sources[0],
        hasBaseline: false,
        origin,
        decisionState: "undecided",
        decisionKind: null,
        isProposedKeeper: false,
        proposalPolicy: null,
      },
      reason: { key: "review.reason.duplicateUndecided", params: { count: sources.length } },
      undated: true,
      suspiciousDate: false,
      futureDate: false,
      setAsideCategory: null,
    };
  });
  return {
    kind: "set",
    key: `set:${id}`,
    id,
    setKind,
    origin,
    rows,
    keeper: rows[0],
    hasBaseline: false,
    decisionState: "undecided",
    decisionKind: null,
    proposedKeeper: null,
    proposalPolicy: null,
    folder: "_stays/undecided",
  };
}

interface QueueOverrides {
  selectedSetIds?: ReadonlySet<string>;
  onSelectSets?: (ids: readonly string[]) => void;
  onToggleSetSelection?: (id: string) => void;
  onClearSetSelection?: () => void;
  onKeep?: (setId: string, source: string) => void;
  onKeepAll?: (setId: string) => void;
  onGo?: (index: number) => void;
  keepSourceByRule?: (setId: string) => string | null;
}

function queue(
  allSets: SetEntry[],
  overrides: QueueOverrides = {},
  current: SetEntry | null = allSets[0] ?? null,
) {
  return (
    <I18nProvider initialLocale="en">
      <ResolveQueue
        queue={current === null ? [] : [current]}
        allSets={allSets}
        current={current}
        index={0}
        onGo={overrides.onGo ?? (() => undefined)}
        onKeep={overrides.onKeep ?? (() => undefined)}
        onKeepAll={overrides.onKeepAll ?? (() => undefined)}
        onAcceptProposal={() => undefined}
        onCompare={() => undefined}
        onOpenDetail={() => undefined}
        onBackToBrowse={() => undefined}
        rule="largest"
        onRule={() => undefined}
        proposalCount={0}
        onAcceptAllProposals={() => undefined}
        selectedSetIds={overrides.selectedSetIds ?? new Set()}
        onToggleSetSelection={overrides.onToggleSetSelection ?? (() => undefined)}
        onSelectSets={overrides.onSelectSets ?? (() => undefined)}
        onClearSetSelection={overrides.onClearSetSelection ?? (() => undefined)}
        keepSourceByRule={overrides.keepSourceByRule ?? (() => null)}
        individualOnly={{ perceptual: 0, unmeasured: 0 }}
      />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("selection-scoped duplicate decisions", () => {
  it("decides two hundred unrankable sets of every origin and kind in three bulk actions", () => {
    const sets = Array.from({ length: 200 }, (_, index) =>
      setEntry(
        `set-${index}`,
        undefined,
        index % 3 === 0 ? "exact" : index % 3 === 1 ? "similar" : "burst",
        index % 2 === 0 ? "catalog" : "plan",
      ),
    );
    const onKeepAll = vi.fn();

    function Harness() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return queue(sets, {
        selectedSetIds: selected,
        onSelectSets: (ids) => setSelected(new Set(ids)),
        onToggleSetSelection: (id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        onClearSetSelection: () => setSelected(new Set()),
        onKeepAll,
      });
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Select all 200" }));
    expect(screen.getByText("200 sets selected")).toBeTruthy();
    const distinct = screen.getByRole("button", { name: "Mark as not duplicates" });
    expect(
      within(distinct.parentElement as HTMLElement).getByText(
        "This decides 200 selected sets and leaves 0 unchanged.",
      ),
    ).toBeTruthy();
    fireEvent.click(distinct);

    expect(onKeepAll).toHaveBeenCalledTimes(200);
    expect(new Set(onKeepAll.mock.calls.map(([id]) => id)).size).toBe(200);
  });

  it("states a rule's exact impact, recomputes it with the live selection, and touches only winners", () => {
    const sets = [setEntry("ranked"), setEntry("unmeasured")];
    const onKeep = vi.fn();
    const keepSourceByRule = (setId: string) =>
      setId === "ranked" ? sets[0].rows[1].source : null;
    const { rerender } = render(
      queue(sets, {
        selectedSetIds: new Set(["ranked", "unmeasured"]),
        onKeep,
        keepSourceByRule,
      }),
    );

    const ruleAction = screen.getByRole("button", { name: "Apply rule to selection" });
    expect(ruleAction.parentElement?.textContent).toContain(
      "This decides 1 selected sets and leaves 1 unchanged.",
    );
    expect(ruleAction.parentElement?.textContent).toContain(
      "The rule cannot rank 1 selected sets because their comparable facts are missing.",
    );

    rerender(
      queue(sets, {
        selectedSetIds: new Set(["ranked"]),
        onKeep,
        keepSourceByRule,
      }),
    );
    const recomputedRule = screen.getByRole("button", { name: "Apply rule to selection" });
    expect(recomputedRule.parentElement?.textContent).toContain(
      "This decides 1 selected sets and leaves 0 unchanged.",
    );
    fireEvent.click(recomputedRule);

    expect(onKeep.mock.calls).toEqual([["ranked", sets[0].rows[1].source]]);
  });

  it("offers only source folders in the selection and reports sets with no unique match", () => {
    const sets = [
      setEntry("one", ["/camera-a/one.jpg", "/camera-b/one.jpg"]),
      setEntry("two", ["/camera-a/two.jpg", "/camera-c/two.jpg"]),
      setEntry("hidden", ["/not-selected/hidden.jpg", "/other/hidden.jpg"]),
    ];
    const onKeep = vi.fn();
    render(
      queue(sets, {
        selectedSetIds: new Set(["one", "two"]),
        onKeep,
      }),
    );

    const folders = screen.getByRole("combobox", { name: "Preferred folder" });
    expect(within(folders).getByRole("option", { name: "/camera-a" })).toBeTruthy();
    expect(within(folders).queryByRole("option", { name: "/not-selected" })).toBeNull();
    fireEvent.change(folders, { target: { value: "/camera-a" } });
    const keepFromFolder = screen.getByRole("button", { name: "Keep from folder" });
    expect(
      within(keepFromFolder.parentElement as HTMLElement).getByText(
        "This decides 2 selected sets and leaves 0 unchanged.",
      ),
    ).toBeTruthy();
    fireEvent.click(keepFromFolder);

    expect(onKeep.mock.calls).toEqual([
      ["one", "/camera-a/one.jpg"],
      ["two", "/camera-a/two.jpg"],
    ]);
  });

  it("ignores out-of-range shortcuts, queue boundaries, and text controls", () => {
    const set = setEntry("one");
    const onKeep = vi.fn();
    const onGo = vi.fn();
    render(queue([set], { selectedSetIds: new Set([set.id]), onKeep, onGo }));

    fireEvent.keyDown(window, { key: "9" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Keep rule" }), { key: "1" });

    expect(onKeep).not.toHaveBeenCalled();
    expect(onGo).not.toHaveBeenCalled();
  });
});
