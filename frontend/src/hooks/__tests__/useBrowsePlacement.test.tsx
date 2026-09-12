// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useBrowsePlacement } from "@/hooks/useBrowsePlacement";
import type { BrowseEntry, SetEntry } from "@/lib/reviewBrowse";

afterEach(cleanup);

const set: SetEntry = {
  kind: "set",
  key: "set:one",
  id: "one",
  setKind: "exact",
  origin: "catalog",
  rows: [],
  keeper: null,
  hasBaseline: false,
  decisionState: "undecided",
  decisionKind: null,
  proposedKeeper: null,
  proposalPolicy: null,
  similarity: 100,
  folder: "_stays/undecided",
};

it("retains only placement, with fresh decision data, until refresh or navigation", () => {
  const { result, rerender } = renderHook(
    ({ entry, context }) => useBrowsePlacement([entry], [entry], context),
    { initialProps: { entry: set, context: "folder-one" } },
  );
  act(() => result.current.pin());
  const decided: SetEntry = {
    ...set,
    folder: "2025/07",
    decisionKind: "keeper",
    decisionState: "decided",
  };
  rerender({ entry: decided, context: "folder-one" });
  expect(result.current.entries).toEqual([{ ...decided, folder: set.folder }]);
  act(() => result.current.refresh());
  expect(result.current.entries).toEqual([decided]);
  act(() => result.current.pin());
  rerender({ entry: set, context: "another-folder" });
  expect(result.current.pinned).toBe(false);
  expect(result.current.entries).toEqual([set]);
});

it("keeps a keep-all card available until its placement is refreshed", () => {
  const { result, rerender } = renderHook(
    ({ entries, sets }) => useBrowsePlacement(entries, sets, "folder"),
    { initialProps: { entries: [set] as BrowseEntry[], sets: [set] } },
  );
  act(() => result.current.pin());
  const distinct: SetEntry = {
    ...set,
    folder: "2025/07",
    decisionKind: "keep_all",
    decisionState: "decided",
  };
  rerender({ entries: [], sets: [distinct] });
  expect(result.current.entries).toEqual([{ ...distinct, folder: set.folder }]);
  act(() => result.current.refresh());
  expect(result.current.entries).toEqual([]);
});
