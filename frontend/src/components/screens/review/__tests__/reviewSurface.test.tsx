// @vitest-environment jsdom

/**
 * The two modes, driven through the rendered screen.
 *
 * The row model and the browse derivation are unit-tested next door; what needs
 * a screen is that the modes are wired to them — that a keeper chosen with the
 * keyboard reaches the run, that a bulk rule can still be argued with
 * afterwards, and that a comparison never fails silently.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { api, type PlanReviewState } from "@/services/api";
import type { Config, OutcomeProvenance, PreviewItem, PreviewResult } from "@/types/api";

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

function durableReviewState(overrides: Partial<PlanReviewState> = {}): PlanReviewState {
  return {
    schema_version: 1,
    config_fingerprint: "test",
    decisions: [],
    selected_set_ids: [],
    mode: "browse",
    queue_set_id: null,
    detail_path: null,
    viewer_path: null,
    search: "",
    tree_path: null,
    view: "list",
    sort: "name",
    keep_policy: "smart",
    ...overrides,
  };
}

interface MemberSpec {
  path: string;
  role?: "input" | "reference";
  size?: number;
}

function group(id: string, members: MemberSpec[], kind: "exact" | "similar" = "exact") {
  return {
    group_id: id,
    kind,
    catalog_generation: 1,
    rule_version: "v1",
    member_count: members.length,
    total_bytes: 3000,
    anchor_member_id: `${id}:0`,
    evidence_summary: "",
    members: members.map((member, index) => ({
      member_id: `${id}:${index}`,
      root_id: "input-a",
      role: member.role ?? "input",
      relative_path: member.path,
      observed_path: member.path,
      facts: {
        size_bytes: member.size ?? 1000,
        modified_at: { known: true, value: 1000 + index, issue: null },
        captured_at: { known: false, value: null, issue: null },
        width: { known: false, value: null, issue: null },
        height: { known: false, value: null, issue: null },
        duration_seconds: { known: false, value: null, issue: null },
        codec: { known: false, value: null, issue: null },
        media_kind: "image",
      },
      evidence: {
        algorithm: "sha256",
        sha256: null,
        signature: null,
        distance: null,
        threshold: null,
        confidence: "high" as const,
        extraction_issues: [],
      },
    })),
  };
}

let decisions: {
  reviewedSets: { keep: string; demote: string[]; keep_all?: boolean }[];
  outstandingSets: number;
  proposedSets: number;
  undecidedSets: number;
  persistenceState: "saving" | "saved" | "error";
  persistenceError: string | null;
  reviewState?: PlanReviewState;
} = {
  reviewedSets: [],
  outstandingSets: 0,
  proposedSets: 0,
  undecidedSets: 0,
  persistenceState: "saving",
  persistenceError: null,
};

function renderReview(
  result: PreviewResult,
  config: Config = { ...TEST_CONFIG, duplicate_keeper_policy: "manual" },
  callbacks: {
    onOpenSetting?: (anchor: string) => void;
    onRerunPreview?: () => void;
    recoveredState?: PlanReviewState | null;
    recoveredStateSaved?: boolean;
    client?: QueryClient;
    strict?: boolean;
  } = {},
) {
  decisions = {
    reviewedSets: [],
    outstandingSets: 0,
    proposedSets: 0,
    undecidedSets: 0,
    persistenceState: "saving",
    persistenceError: null,
  };
  const client =
    callbacks.client ??
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const review = (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ReviewScreen
          result={result}
          config={config}
          recoveredStateSaved={callbacks.recoveredStateSaved}
          recoveredState={
            callbacks.recoveredState === undefined
              ? durableReviewState({
                  mode: "browse",
                  keep_policy: config.duplicate_keeper_policy,
                })
              : callbacks.recoveredState
          }
          onOpenSetting={callbacks.onOpenSetting ?? (() => {})}
          onRerunPreview={callbacks.onRerunPreview ?? (() => {})}
          onDecisionsChange={(next) => {
            decisions = next;
          }}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
  return render(callbacks.strict ? <StrictMode>{review}</StrictMode> : review);
}

const en = (key: string, params?: Record<string, string | number>) => translate("en", key, params);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rowCheckbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

function switchTo(mode: "browse" | "resolve") {
  fireEvent.click(screen.getByRole("tab", { name: en(`review.mode.${mode}`) }));
}

/** Compare a copy against the other copy of its pair, from the copy's own row. */
function compareCopy(name: string, other: string) {
  fireEvent.click(
    screen.getByRole("button", { name: en("review.compare.withCopy", { name, other }) }),
  );
}

/**
 * Take the keep rule's offer over every open set.
 *
 * A decision covering more than one set states its impact before it acts, so
 * the entry control opens the dialog and the dialog's own action commits — the
 * same two steps on Browse and on Resolve.
 */
function acceptAllRecommendations(count: number) {
  fireEvent.click(
    screen.getByRole("button", {
      name: en(count === 1 ? "review.keepRule.applyToOpen.one" : "review.keepRule.applyToOpen", {
        count,
      }),
    }),
  );
  const dialog = screen.getByRole("dialog", { name: en("review.bulk.recommendTitle") });
  fireEvent.click(
    within(dialog).getByRole("button", { name: en("review.bulk.acceptRecommendations") }),
  );
}

async function waitForReview() {
  await screen.findByRole("tab", { name: en("review.mode.resolve") });
}

/** The tree's "make this folder the subject" control, by folder name. */
function showContents(folder: string) {
  fireEvent.click(
    screen.getByRole("button", { name: en("review.browse.showContents", { folder }) }),
  );
}

beforeEach(() => {
  // Give every test a fresh browser profile. Node versions differ on whether
  // jsdom's localStorage is available, so relying on the runner's
  // implementation made this file pass locally and fail in CI.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
  });
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
    truncated: false,
    partial_index: false,
    kind: "exact",
  });
  vi.spyOn(api, "savePlanReviewState").mockImplementation(async (_planId, state) => state);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("review entry", () => {
  it("opens Browse when a new plan has no duplicate decisions", async () => {
    localStorage.setItem("mediasort_review_mode", "browse");
    renderReview(
      previewResult(item()),
      { ...TEST_CONFIG, duplicate_keeper_policy: "manual" },
      { recoveredState: null },
    );
    await waitForReview();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: en("review.mode.browse") }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(localStorage.getItem("mediasort_review_mode")).toBeNull();
  });

  it("opens on the result browser even when a new plan has duplicates to decide", async () => {
    // Arriving from Plan, the first question is "what would this run do".
    // Landing on the decision queue asked for judgements about files before
    // the reader had seen a single one of them; the outstanding count on the
    // Resolve tab is what says there is work waiting there.
    renderReview(
      previewResult(
        item({ source: "/in/a.jpg" }),
        item({
          source: "/in/a-copy.jpg",
          status: "duplicate",
          duplicate_of: "/in/a.jpg",
        }),
      ),
      undefined,
      { recoveredState: null },
    );
    await waitForReview();

    expect(
      screen.getByRole("tab", { name: en("review.mode.browse") }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("settles durable persistence when React StrictMode remounts effects", async () => {
    renderReview(previewResult(item()), undefined, { recoveredState: null, strict: true });
    await waitForReview();

    await waitFor(() => expect(decisions.persistenceState).toBe("saved"));
    expect(api.savePlanReviewState).toHaveBeenCalled();
  });
});

describe("browse", () => {
  const result = previewResult(
    item({ source: "/in/holiday.jpg", destination: "/out/2025/07/holiday.jpg" }),
    item({ source: "/in/beach.jpg", destination: "/out/2025/08/beach.jpg" }),
    item({
      source: "/in/screenshot.png",
      destination: "/out/_junk/screenshot.png",
      status: "junk",
    }),
  );

  it("narrows the pane to the folder whose contents were asked for", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });

    showContents("_junk");

    expect(screen.getByRole("checkbox", { name: "screenshot.png" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();
  });

  it("presents dates the way a person reads them, not as raw ISO", async () => {
    // The date column truncates, so an ISO timestamp rendered verbatim showed
    // as "2025-07-04T09:3…" — unreadable, and ignoring the active locale while
    // History and the report already formatted theirs.
    renderReview(
      previewResult(
        item({
          source: "/in/holiday.jpg",
          destination: "/out/2025/07/holiday.jpg",
          extracted_date: "2025-07-04T09:30:00",
        }),
      ),
    );
    await screen.findByRole("checkbox", { name: "holiday.jpg" });

    expect(document.body.textContent).not.toContain("2025-07-04T09:30:00");
    expect(document.body.textContent).toContain("Jul 4, 2025");
  });

  it("shows the whole plan when the destination root is selected", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });

    showContents(en("review.tree.root"));

    expect(screen.getByRole("checkbox", { name: "holiday.jpg" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "beach.jpg" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "screenshot.png" })).toBeTruthy();
    expect(screen.getByText(en("review.browse.scopeAll", { count: 3 }))).toBeTruthy();
  });

  it("distinguishes a search with no matches and clears only that search", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });
    showContents("_junk");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not-present" } });

    expect(
      screen.getByText(en("review.browse.searchMatchesNothing", { query: "not-present" })),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en("review.browse.clearSearch") }));

    expect(screen.getByRole("checkbox", { name: "screenshot.png" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "beach.jpg" })).toBeNull();
  });

  it("rebuilds the destination tree when Browse comes back into view", async () => {
    // The tree is built for Browse only — it is the one derivation a decision
    // invalidates that Resolve never draws. Leaving Resolve has to rebuild it,
    // or Browse returns to an empty folder list.
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });
    const folder = () =>
      screen.queryByRole("button", { name: en("review.browse.expand", { folder: "2025" }) });
    expect(folder()).toBeTruthy();

    switchTo("resolve");
    switchTo("browse");

    expect(folder()).toBeTruthy();
  });

  it("separates expanding a folder from selecting it", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });

    // Two controls on the row, two different accessible names, two jobs.
    expect(
      screen.getByRole("button", { name: en("review.browse.expand", { folder: "2025" }) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en("review.browse.showContents", { folder: "2025" }) }),
    ).toBeTruthy();
  });

  it("composes the search box with the folder", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "holiday.jpg" });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "beach" } });

    expect(screen.getByRole("checkbox", { name: "beach.jpg" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "holiday.jpg" })).toBeNull();
  });
});

describe("catalog states", () => {
  const result = previewResult(
    item({ source: "/in/holiday.jpg", destination: "/out/2025/07/holiday.jpg" }),
  );

  it("does not claim there are no duplicate sets before the catalog answers", () => {
    vi.spyOn(api, "listReviewGroups").mockReturnValue(new Promise(() => {}));

    renderReview(result);

    expect(screen.queryByText(en("review.resolve.doneTitle"))).toBeNull();
    expect(screen.getByText(en("review.catalog.loading"))).toBeTruthy();
  });

  it("shows a catalog failure with its stable code instead of reporting zero", async () => {
    vi.spyOn(api, "listReviewGroups").mockRejectedValue({
      response: {
        data: {
          error: "The duplicate catalog is unavailable.",
          code: "CATALOG_UNAVAILABLE",
        },
      },
    });

    renderReview(result);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The duplicate catalog is unavailable.",
    );
    expect(screen.getByRole("alert").textContent).toContain("CATALOG_UNAVAILABLE");
    expect(screen.queryByText(en("review.resolve.doneTitle"))).toBeNull();
  });
});

describe("the stays branch", () => {
  const result = previewResult(
    item({ source: "/in/keep.jpg", destination: "/out/2025/07/keep.jpg" }),
    item({ source: "/in/dup-a.jpg", destination: "/out/2025/07/dup-a.jpg" }),
    item({ source: "/in/dup-b.jpg", destination: "/out/_duplicates/dup-b.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact"
          ? [group("set-1", [{ path: "/in/dup-a.jpg" }, { path: "/in/dup-b.jpg" }])]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("lists an undecided set there and nowhere else", async () => {
    renderReview(result);
    await screen.findByRole("button", {
      name: en("review.browse.showContents", { folder: en("review.browse.stays.undecided") }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: en("review.browse.expand", { folder: "2025" }) }),
    );
    showContents("07");

    expect(screen.queryByRole("checkbox", { name: "dup-a.jpg" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "keep.jpg" })).toBeTruthy();
  });

  it("says how many sets are waiting, and the queue holds exactly that many", async () => {
    renderReview(result, undefined, {
      recoveredState: durableReviewState({ mode: "resolve", keep_policy: "manual" }),
    });
    await waitForReview();

    expect(
      screen.getByText(new RegExp(`${en("review.resolve.position", { index: 1, total: 1 })}`)),
    ).toBeTruthy();
  });
});

describe("resolve", () => {
  const result = previewResult(
    item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
    item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
    item({ source: "/in/c.jpg", destination: "/out/2025/07/c.jpg" }),
    item({ source: "/in/d.jpg", destination: "/out/_duplicates/d.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact"
          ? [
              group("set-1", [
                { path: "/in/a.jpg", size: 1000 },
                { path: "/in/b.jpg", size: 4000 },
              ]),
              group("set-2", [
                { path: "/in/c.jpg", size: 9000 },
                { path: "/in/d.jpg", size: 2000 },
              ]),
            ]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("moves to the next open set once a decision is made", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");

    const positionIs = (index: number) =>
      screen.getByText(new RegExp(`${en("review.resolve.position", { index, total: 2 })}`));
    expect(positionIs(1)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );

    // The decision stands, and the queue has moved on by itself.
    expect(decisions.reviewedSets).toEqual([{ keep: "/in/b.jpg", demote: ["/in/a.jpg"] }]);
    expect(positionIs(2)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "c.jpg" })).toBeTruthy();
  });

  it("serializes rapid durable saves so the newest decisions win", async () => {
    const firstSave = deferred<PlanReviewState>();
    const save = vi
      .mocked(api.savePlanReviewState)
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementation(async (_planId, state) => state);
    renderReview(result, undefined, {
      recoveredState: durableReviewState({ mode: "resolve", keep_policy: "manual" }),
    });
    await waitForReview();

    for (const name of ["b.jpg", "d.jpg"]) {
      fireEvent.click(
        screen.getByRole("button", {
          name: en("review.resolve.keepThis", { name, number: 2 }),
        }),
      );
    }

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1].decisions).toHaveLength(1);
    await act(async () => firstSave.resolve(save.mock.calls[0][1]));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][1].decisions).toHaveLength(2);
    await waitFor(() => expect(decisions.persistenceState).toBe("saved"));
  });

  it("finishes pending drafts in order across navigation without claiming an unsaved draft is durable", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstSave = deferred<PlanReviewState>();
    const save = vi
      .mocked(api.savePlanReviewState)
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementation(async (_planId, state) => state);
    const first = renderReview(result, undefined, {
      client,
      recoveredState: durableReviewState({ mode: "resolve", keep_policy: "manual" }),
    });
    await waitForReview();
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "d.jpg", number: 2 }),
      }),
    );
    const draft = decisions.reviewState;
    expect(draft?.decisions).toHaveLength(2);
    first.unmount();
    renderReview(result, undefined, { client, recoveredState: draft, recoveredStateSaved: false });
    await waitForReview();
    switchTo("browse");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "b.jpg" } });
    expect(decisions.persistenceState).toBe("saving");
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => firstSave.resolve(save.mock.calls[0][1]));
    await waitFor(() => expect(decisions.persistenceState).toBe("saved"));
    const final = save.mock.calls[save.mock.calls.length - 1]?.[1];
    expect(final?.decisions).toHaveLength(2);
    expect(final?.search).toBe("b.jpg");
  });

  it("stays put when the set just decided was the last one open", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");

    for (const name of ["b.jpg", "d.jpg"]) {
      fireEvent.click(
        screen.getByRole("button", {
          name: en("review.resolve.keepThis", { name, number: 2 }),
        }),
      );
    }

    expect(screen.getByText(en("review.resolve.doneTitle"))).toBeTruthy();
  });

  it("numbers the queue in the order the list is shown in", async () => {
    // Distinct sizes, so ordering by size is something other than a no-op:
    // set-2 weighs 9 KB against set-1's 1 KB and leads under that order.
    const weighted = previewResult(
      item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
      item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
      item({ source: "/in/c.jpg", destination: "/out/2025/07/c.jpg", file_size: 9000 }),
      item({ source: "/in/d.jpg", destination: "/out/_duplicates/d.jpg", file_size: 9000 }),
    );
    renderReview(weighted);
    await waitForReview();
    switchTo("resolve");

    // By name, set-1 (a.jpg) leads. Ordering by size puts set-2 (c.jpg, 9000)
    // first, and the position, the arrows and the list must all agree — a
    // counter that names a row twelve places down the list is worse than none.
    const positionIs = (index: number) =>
      screen.getByText(new RegExp(`${en("review.resolve.position", { index, total: 2 })}`));

    expect(positionIs(1)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "a.jpg" })).toBeTruthy();

    fireEvent.change(screen.getAllByRole("combobox", { name: en("review.sort.label") })[0], {
      target: { value: "size" },
    });

    expect(positionIs(1)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "c.jpg" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.next") }));

    expect(positionIs(2)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "a.jpg" })).toBeTruthy();
  });

  it("keeps a copy by activating it, and the run is told", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");

    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );

    expect(decisions.reviewedSets).toEqual([{ keep: "/in/b.jpg", demote: ["/in/a.jpg"] }]);
  });

  it("resolves by keyboard alone, with no pointer anywhere", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");

    // A number key keeps that copy outright: the queue's contract is that a
    // keeper is chosen by activating a copy, with no second command control.
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2" });

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/a.jpg",
      "/in/d.jpg",
    ]);
  });

  /**
   * This used to assert that a digit typed while the *mode tab* held focus
   * selected a keeper. That is the WCAG 2.1.4 violation `P0-UI-001` fixes: the
   * queue commits keeper decisions, and a stray `1` anywhere on the screen
   * changed which file the next confirmation would keep.
   *
   * The shortcut is now scoped to focus-within the queue, and activating
   * Resolve moves focus into it — so the reachable path this test covered is
   * preserved, while the unreachable-from-anywhere behaviour is gone.
   */
  it("accepts a number shortcut once Resolve has taken focus", async () => {
    renderReview(result);
    await waitForReview();

    fireEvent.click(screen.getByRole("tab", { name: en("review.mode.resolve") }));
    fireEvent.keyDown(window, { key: "1" });

    expect(decisions.reviewedSets).toEqual([{ keep: "/in/a.jpg", demote: ["/in/b.jpg"] }]);
  });

  it("ignores a number shortcut once focus leaves the queue for the mode tab", async () => {
    renderReview(result);
    await waitForReview();
    const resolveMode = screen.getByRole("tab", {
      name: en("review.mode.resolve"),
    }) as HTMLButtonElement;

    fireEvent.click(resolveMode);
    // Deliberately take focus back out of the queue.
    resolveMode.focus();
    fireEvent.keyDown(resolveMode, { key: "1" });

    // The shortcut decides outright now, so a key that reaches this listener
    // would be visible as a decision rather than as a pending draft.
    expect(decisions.reviewedSets).toEqual([]);
    expect(
      (
        screen.getByRole("button", {
          name: en("review.resolve.keepThis", { name: "a.jpg", number: 1 }),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("records 'not duplicates' as a binding decision instead of clearing the set", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");

    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.keepAll") }));

    expect(decisions.reviewedSets).toEqual([
      {
        keep: "/in/a.jpg",
        demote: ["/in/b.jpg"],
        keep_all: true,
      },
    ]);
  });

  it("does not let queue shortcuts decide a set through an open dialog", async () => {
    renderReview(result);
    await waitForReview();
    switchTo("resolve");
    compareCopy("a.jpg", "b.jpg");

    fireEvent.keyDown(window, { key: "2" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(decisions.reviewedSets).toEqual([]);
  });

  it("applies a rule to every set it can decide, and each stays overridable", async () => {
    // Stated rather than inherited: the rule is what decides which copy wins,
    // so a test about the rule must not depend on the fixture's default.
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");

    // A rule has ranked both sets, but a proposal binds nothing.
    expect(decisions.reviewedSets).toEqual([]);
    acceptAllRecommendations(2);
    // "Keep the largest" is the fixture's default rule.
    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/b.jpg",
      "/in/c.jpg",
    ]);

    // The queue is empty now, so the override is made from Browse — which is
    // the point: a bulk decision is a decision, not a lock. The set is one
    // collapsed entry, so it is opened first.
    switchTo("browse");
    const headers = screen.getAllByRole("button", {
      name: new RegExp(en("review.stack.copies", { count: 2 })),
    });
    fireEvent.click(headers[0]);
    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.click(screen.getByRole("button", { name: en("review.keepOnlyThis") }));

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/a.jpg",
      "/in/c.jpg",
    ]);
  });

  it("draws an unaccepted proposal as a suggestion, not as a kept file", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();

    const header = screen.getAllByRole("button", {
      name: new RegExp(en("review.stack.copies", { count: 2 })),
    })[0];
    fireEvent.click(header);

    expect(screen.getByText(en("recipes.recommended"))).toBeTruthy();
    expect(screen.queryByText(en("review.resolve.kept"))).toBeNull();
    expect(screen.getAllByRole("button", { name: en("review.detail.makeKeeper") })).toHaveLength(2);
  });

  it("accepts one proposal and re-proposes only the outstanding sets when the rule changes", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");

    // Accepting one proposal is keeping the copy it names — one press, on the
    // copy, exactly as any other keeper choice.
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );
    expect(decisions.reviewedSets.map((set) => set.keep)).toEqual(["/in/b.jpg"]);
    expect(decisions).toMatchObject({ outstandingSets: 1, proposedSets: 1, undecidedSets: 0 });

    fireEvent.change(screen.getByRole("combobox", { name: en("review.keepRule") }), {
      target: { value: "smallest" },
    });
    expect(decisions.reviewedSets.map((set) => set.keep)).toEqual(["/in/b.jpg"]);
    acceptAllRecommendations(1);

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/b.jpg",
      "/in/d.jpg",
    ]);
    expect(decisions.outstandingSets).toBe(0);
  });

  it("reset-one and reset-all remove only explicit choices and leave proposals non-binding", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");
    acceptAllRecommendations(2);
    expect(decisions.reviewedSets).toHaveLength(2);

    switchTo("browse");
    fireEvent.click(screen.getAllByRole("button", { name: en("review.browse.openResult") })[0]);
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.resetOne") }));

    await waitFor(() => expect(decisions.reviewedSets).toHaveLength(1));
    expect(decisions).toMatchObject({ outstandingSets: 1, proposedSets: 1, undecidedSets: 0 });

    // Clearing every decision at once is the one act in Review that a second
    // press does not undo, so it asks first.
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.resetAll") }));
    expect(decisions.reviewedSets).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.resetAll.confirm") }));

    await waitFor(() => expect(decisions.reviewedSets).toEqual([]));
    expect(decisions).toMatchObject({ outstandingSets: 2, proposedSets: 2, undecidedSets: 0 });
  });

  it("keeps every decision when the clear-all confirmation is dismissed", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");
    acceptAllRecommendations(2);
    expect(decisions.reviewedSets).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.resetAll") }));
    fireEvent.click(screen.getByRole("button", { name: en("common.cancel") }));

    expect(decisions.reviewedSets).toHaveLength(2);
  });

  it("rehydrates explicit choices and view state for the same plan, never a different plan", async () => {
    const first = renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );
    switchTo("browse");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a.jpg" } });

    let persisted: PlanReviewState | undefined;
    await waitFor(() => {
      persisted = vi
        .mocked(api.savePlanReviewState)
        .mock.calls.map((call) => call[1])
        .find(
          (state) =>
            state.search === "a.jpg" &&
            state.decisions.some((decision) => decision.group_id === "set-1"),
        );
      expect(persisted).toBeTruthy();
    });
    first.unmount();

    const recovered = renderReview(
      result,
      { ...TEST_CONFIG, duplicate_keeper_policy: "largest" },
      { recoveredState: persisted },
    );
    await waitForReview();
    await waitFor(() =>
      expect(decisions.reviewedSets).toEqual([{ keep: "/in/b.jpg", demote: ["/in/a.jpg"] }]),
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("a.jpg");
    recovered.unmount();

    renderReview(
      { ...result, plan_id: "plan-different" },
      {
        ...TEST_CONFIG,
        duplicate_keeper_policy: "largest",
      },
    );
    await waitForReview();
    await waitFor(() => expect(decisions.reviewedSets).toEqual([]));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });

  it("removes legacy browser snapshots and writes the backend-owned state", async () => {
    localStorage.setItem("mediasort_review_state:plan-older", "{}");
    localStorage.setItem("mediasort_review_state:plan-oldest", "{}");

    renderReview(result, undefined, { recoveredState: null });
    await waitForReview();

    await waitFor(() => expect(api.savePlanReviewState).toHaveBeenCalled());
    expect(localStorage.getItem(`mediasort_review_state:${result.plan_id}`)).toBeNull();
    expect(localStorage.getItem("mediasort_review_state:plan-older")).toBeNull();
    expect(localStorage.getItem("mediasort_review_state:plan-oldest")).toBeNull();
  });

  it("rejects review state whose configuration fingerprint is stale", async () => {
    renderReview(
      result,
      { ...TEST_CONFIG, duplicate_keeper_policy: "largest" },
      {
        recoveredState: durableReviewState({
          config_fingerprint: "different-config",
          decisions: [{ group_id: "set-1", kind: "keeper", member_id: "set-1:1" }],
        }),
      },
    );
    await waitForReview();
    await screen.findAllByRole("button", {
      name: new RegExp(en("review.stack.copies", { count: 2 })),
    });
    await waitFor(() => expect(decisions.reviewedSets).toEqual([]));
  });

  it("rehydrates the exact duplicate-set queue position", async () => {
    const first = renderReview(result);
    await waitForReview();
    switchTo("resolve");
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.next") }));
    expect(
      screen.getByText(new RegExp(`${en("review.resolve.position", { index: 2, total: 2 })}`)),
    ).toBeTruthy();

    let persisted: PlanReviewState | undefined;
    await waitFor(() => {
      persisted = vi
        .mocked(api.savePlanReviewState)
        .mock.calls.map((call) => call[1])
        .find((state) => state.queue_set_id === "set-2");
      expect(persisted).toBeTruthy();
    });
    first.unmount();

    renderReview(result, undefined, { recoveredState: persisted });
    await waitForReview();
    expect(
      screen.getByText(new RegExp(`${en("review.resolve.position", { index: 2, total: 2 })}`)),
    ).toBeTruthy();
  });

  it("shares set selection between Browse and Resolve and keeps a bulk result overridable", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", {
      name: en("review.setSelection.toggle", { name: "a.jpg" }),
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "a.jpg" }),
      }),
    );
    expect(screen.getByText(en("review.setSelection.count.one"))).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "c.jpg" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: en("review.setSelection.review") }));
    expect(screen.getByText(en("review.setSelection.count", { count: 2 }))).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: en("review.bulk.open") })[0]);
    const bulk = screen.getByRole("dialog", { name: en("review.bulk.selectionTitle") });
    fireEvent.click(within(bulk).getByRole("button", { name: en("review.bulk.notDuplicates") }));
    expect(decisions.reviewedSets).toEqual([
      { keep: "/in/a.jpg", demote: ["/in/b.jpg"], keep_all: true },
      { keep: "/in/c.jpg", demote: ["/in/d.jpg"], keep_all: true },
    ]);
    expect(decisions.outstandingSets).toBe(0);

    // "Not duplicates" expands the files back into their own destinations in
    // Browse, while retaining the set identity needed for an override.
    switchTo("browse");
    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.click(screen.getByRole("button", { name: en("review.keepOnlyThis") }));

    expect(decisions.reviewedSets).toEqual([
      { keep: "/in/a.jpg", demote: ["/in/b.jpg"] },
      { keep: "/in/c.jpg", demote: ["/in/d.jpg"], keep_all: true },
    ]);
  });

  it("selects the visible collapsed sets with Ctrl/Cmd+A", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", {
      name: en("review.setSelection.toggle", { name: "a.jpg" }),
    });

    fireEvent.keyDown(window, { key: "a", ctrlKey: true });

    expect(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "a.jpg" }),
      }),
    ).toHaveProperty("checked", true);
    expect(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "c.jpg" }),
      }),
    ).toHaveProperty("checked", true);
    expect(screen.getByText(en("review.setSelection.count", { count: 2 }))).toBeTruthy();
  });

  it("ends with a way back rather than an empty frame", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");
    acceptAllRecommendations(2);

    expect(
      screen.getByText(new RegExp(en("review.resolve.decidedCount", { decided: 2, total: 2 }))),
    ).toBeTruthy();
    switchTo("browse");
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("says the work is finished across the top, above the panes", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();
    switchTo("resolve");
    acceptAllRecommendations(2);

    // "Am I done?" is answered at the top of the surface, not inside the
    // right-hand pane above whichever set happens to be open — where it was
    // narrower than the thing it reported on and the first thing to scroll
    // away. `compareDocumentPosition` is the assertion because "at the top"
    // is a claim about order, and a class name is not.
    const done = screen.getByText(en("review.resolve.doneTitle"));
    const list = screen.getByText(en("review.resolve.allSets"));
    expect(done.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/**
 * Browse has to be enough on its own.
 *
 * Every duplicate set must become an explicit decision before Execute unlocks,
 * and the only bulk way to do that used to live on the other tab — so a reader
 * who did not care which copy survived still had to open a decision queue to
 * finish a run they had already understood.
 */
describe("browsing alone is enough to finish a run", () => {
  const result = previewResult(
    item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
    item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
    item({ source: "/in/c.jpg", destination: "/out/2025/07/c.jpg" }),
    item({ source: "/in/d.jpg", destination: "/out/_duplicates/d.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact"
          ? [
              // Distinct sizes, so "keep the largest" names one copy rather
              // than falling through to the stable-identity tie-break.
              group("set-1", [
                { path: "/in/a.jpg", size: 1000 },
                { path: "/in/b.jpg", size: 4000 },
              ]),
              group("set-2", [
                { path: "/in/c.jpg", size: 9000 },
                { path: "/in/d.jpg", size: 2000 },
              ]),
            ]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("states what is open, and clears it without opening the queue", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();

    // Browse is the landing tab, and it says what is left rather than only
    // marking a badge on the tab beside it.
    expect(
      screen.getByRole("tab", { name: en("review.mode.browse") }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(en("review.browse.openSets", { count: 2 }))).toBeTruthy();
    expect(decisions.outstandingSets).toBe(2);

    acceptAllRecommendations(2);

    expect(decisions.outstandingSets).toBe(0);
    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/b.jpg",
      "/in/c.jpg",
    ]);
    // Never left the tab it started on.
    expect(
      screen.getByRole("tab", { name: en("review.mode.browse") }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("takes the selection-scoped decisions from Browse too", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "manual" });
    await waitForReview();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "a.jpg" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: en("review.bulk.open") }));
    const bulk = screen.getByRole("dialog", { name: en("review.bulk.selectionTitle") });
    fireEvent.click(within(bulk).getByRole("button", { name: en("review.bulk.notDuplicates") }));

    expect(decisions.reviewedSets).toEqual([
      { keep: "/in/a.jpg", demote: ["/in/b.jpg"], keep_all: true },
    ]);
  });

  it("narrows a not-duplicates set back to one keeper without a reset first", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "manual" });
    await waitForReview();
    switchTo("resolve");

    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.keepAll") }));
    expect(decisions.reviewedSets).toEqual([
      { keep: "/in/a.jpg", demote: ["/in/b.jpg"], keep_all: true },
    ]);

    // Deciding an open set advances to the next one still open; walk back to
    // the set just decided, which is what the arrow is for.
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.previous") }));

    // Every copy is kept, so every copy shows as kept — but choosing one is
    // still a decision the reader may make, and it must not require clearing
    // the set first.
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "b.jpg", number: 2 }),
      }),
    );

    expect(decisions.reviewedSets).toEqual([{ keep: "/in/b.jpg", demote: ["/in/a.jpg"] }]);
  });

  it("never overwrites a decision the reader made by hand", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await waitForReview();

    // Decide one set against the rule: "largest" ranks b.jpg first here.
    switchTo("resolve");
    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.resolve.keepThis", { name: "a.jpg", number: 1 }),
      }),
    );
    expect(decisions.reviewedSets.map((set) => set.keep)).toEqual(["/in/a.jpg"]);

    switchTo("browse");
    // One set is decided, so only the other is still an offer.
    acceptAllRecommendations(1);

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/a.jpg",
      "/in/c.jpg",
    ]);
  });
});

describe("a baseline decides its own set", () => {
  const result = previewResult(
    item({ source: "/ref/base.jpg", destination: "/out/2025/07/base.jpg" }),
    item({ source: "/in/copy.jpg", destination: "/out/_duplicates/copy.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact"
          ? [
              group("set-ref", [
                { path: "/ref/base.jpg", role: "reference" },
                { path: "/in/copy.jpg" },
              ]),
            ]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("never puts it in the queue, and says the reference is protected", async () => {
    renderReview(result);
    await waitForReview();

    switchTo("resolve");
    expect(screen.getByText(en("review.resolve.doneTitle"))).toBeTruthy();
  });

  it("allows inspection but exposes no keeper decision for a protected-reference set", async () => {
    renderReview(result);
    await waitForReview();

    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(en("review.stack.copies", { count: 2 })),
      }),
    );
    expect(screen.queryByRole("button", { name: en("review.detail.makeKeeper") })).toBeNull();

    fireEvent.click(rowCheckbox("copy.jpg"));
    expect(
      (screen.getByRole("button", { name: en("review.keepOnlyThis") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: en("review.compare.title") }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("button", {
        name: en("review.compare.keepBoth", { count: 2 }),
      }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: en("review.compare.confirmSelection") }),
    ).toBeNull();
    expect(decisions.reviewedSets).toEqual([]);
  });
});

describe("comparing never fails silently", () => {
  const result = previewResult(
    item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
    item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
    item({ source: "/in/unrelated.jpg", destination: "/out/2025/08/unrelated.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact" ? [group("set-1", [{ path: "/in/a.jpg" }, { path: "/in/b.jpg" }])] : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("compares two files from different sets, without offering a keeper", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "unrelated.jpg" });

    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(en("review.stack.copies", { count: 2 })),
      }),
    );
    await screen.findByRole("checkbox", { name: "a.jpg" });

    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.click(rowCheckbox("unrelated.jpg"));
    fireEvent.click(screen.getByRole("button", { name: en("review.compare") }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(en("review.compare.notOneSet"))).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: en("review.compare.keepA") })).toBeNull();
  });

  it("reaches every pair of a three-copy set, including the one without the first", async () => {
    const three = previewResult(
      item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
      item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
      item({ source: "/in/c.jpg", destination: "/out/_duplicates/c.jpg" }),
    );
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact"
          ? [group("set-1", [{ path: "/in/a.jpg" }, { path: "/in/b.jpg" }, { path: "/in/c.jpg" }])]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
    renderReview(three);
    await waitForReview();
    switchTo("resolve");

    // Opening from a.jpg lands on the pair it names.
    compareCopy("a.jpg", "b.jpg");
    const dialog = screen.getByRole("dialog", { name: en("review.compare.title") });
    expect(within(dialog).getByText(en("review.compare.copyPosition", { index: 1, total: 3 })));

    // Three copies make three pairs, and walking them reaches b against c —
    // the comparison a fixed left-hand side could never produce. The pair is
    // read off the fact table's own column headings, which name each copy by
    // the letter it keeps for the whole set rather than by which half of the
    // screen it landed on.
    const pairOnScreen = () =>
      within(dialog)
        .getAllByRole("button", { name: /^[A-Z] — / })
        .map((heading) => heading.textContent)
        .join(" | ");

    const pairs: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      pairs.push(pairOnScreen());
      fireEvent.click(within(dialog).getByRole("button", { name: en("review.compare.nextCopy") }));
    }

    expect(new Set(pairs).size).toBe(3);
    // b is B in every pair it appears in, including the one where it is on the
    // left. A letter that meant "the left-hand side" silently renamed both
    // copies each time the pair changed.
    expect(pairs).toContain("A — a.jpg | B — b.jpg");
    expect(pairs).toContain("A — a.jpg | C — c.jpg");
    expect(pairs).toContain("B — b.jpg | C — c.jpg");
    // And walking all the way round returns to where it started.
    expect(pairOnScreen()).toBe(pairs[0]);

    // Every pairing is also one press away, rather than only reachable by
    // stepping around the ring.
    for (const [first, second] of [
      ["a.jpg", "b.jpg"],
      ["a.jpg", "c.jpg"],
      ["b.jpg", "c.jpg"],
    ]) {
      expect(
        within(dialog).getByRole("button", {
          name: en("review.compare.selectPair", { a: first, b: second }),
        }),
      ).toBeTruthy();
    }

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: en("review.compare.selectPair", { a: "b.jpg", b: "c.jpg" }),
      }),
    );
    expect(pairOnScreen()).toBe("B — b.jpg | C — c.jpg");
  });

  it("compares a set against its own members even when the pane hides one", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "unrelated.jpg" });

    // Narrow the pane so only one member of the set could possibly be visible.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a.jpg" } });
    switchTo("resolve");
    compareCopy("a.jpg", "b.jpg");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(en("review.compare.scopeNote"))).toBeTruthy();
  });
});

describe("selecting a file and opening a file are different gestures", () => {
  /** Two ordinary files, so nothing here is about duplicate sets. */
  const plan = () =>
    previewResult(
      item({ source: "/in/one.jpg", destination: "/out/2025/07/one.jpg" }),
      item({ source: "/in/two.jpg", destination: "/out/2025/07/two.jpg" }),
    );

  it("selects when the row itself is activated, and opens nothing", async () => {
    renderReview(plan());
    await screen.findByText("one.jpg");

    const row = screen.getByText("one.jpg").closest("[data-selected]") as HTMLElement;
    fireEvent.click(row);

    expect(rowCheckbox("one.jpg").checked).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens when the name is activated, and selects nothing", async () => {
    renderReview(plan());
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(rowCheckbox("one.jpg").checked).toBe(false);
  });

  it("keeps the checkbox working as the keyboard-reachable selection control", async () => {
    renderReview(plan());
    await screen.findByText("one.jpg");

    fireEvent.click(rowCheckbox("one.jpg"));

    expect(rowCheckbox("one.jpg").checked).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("walks the folder from the detail view, not only a duplicate set", async () => {
    // The reported defect: for a file in no set both arrows sat disabled beside
    // "not part of a duplicate set", which reads as a fault rather than a bound.
    renderReview(plan());
    await screen.findByText("one.jpg");
    fireEvent.click(screen.getByText("one.jpg"));

    const dialog = await screen.findByRole("dialog");
    const next = within(dialog).getByRole("button", {
      name: en("review.detail.next"),
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    fireEvent.click(next);
    expect(within(await screen.findByRole("dialog")).getByText("two.jpg")).toBeTruthy();
  });

  it("states the independent file-info and provenance loading states", async () => {
    vi.spyOn(api, "getMediaInfo").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "reviewOutcomes").mockReturnValue(new Promise(() => {}));
    renderReview(plan());
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(en("review.detail.infoLoading"))).toBeTruthy();
    expect(within(dialog).getByText(en("review.detail.provenanceLoading"))).toBeTruthy();
    expect(within(dialog).queryByText(en("review.detail.provenanceUnavailable"))).toBeNull();
  });

  it("states independent lookup failures with their codes and remains usable", async () => {
    vi.spyOn(api, "getMediaInfo").mockRejectedValue({
      response: { data: { error: "Metadata lookup failed.", code: "MEDIA_INFO_FAILED" } },
    });
    vi.spyOn(api, "reviewOutcomes").mockRejectedValue({
      response: { data: { error: "Outcome lookup failed.", code: "OUTCOME_FAILED" } },
    });
    renderReview(plan());
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Metadata lookup failed.")).toBeTruthy();
    expect(within(dialog).getByText("MEDIA_INFO_FAILED")).toBeTruthy();
    expect(await within(dialog).findByText("Outcome lookup failed.")).toBeTruthy();
    expect(within(dialog).getByText("OUTCOME_FAILED")).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: en("state.retry") })).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: en("common.close") })).toBeTruthy();
  });

  it("distinguishes settled empty lookup results from loading and failure", async () => {
    vi.spyOn(api, "getMediaInfo").mockResolvedValue({
      width: null,
      height: null,
      file_size: null,
      extracted_date: null,
      metadata_source: "none",
      media_type: "other",
    });
    vi.spyOn(api, "reviewOutcomes").mockResolvedValue({
      config_fingerprint: "test",
      outcomes: [],
      unavailable_paths: ["/in/one.jpg"],
    });
    renderReview(plan());
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(en("review.detail.provenanceUnavailable"))).toBeTruthy();
    expect(within(dialog).queryByText(en("review.detail.infoLoading"))).toBeNull();
    expect(within(dialog).queryByText(en("review.detail.provenanceLoading"))).toBeNull();
  });

  it("names a superseded explanation, keeps file facts visible, and offers a new preview", async () => {
    const rerun = vi.fn();
    vi.spyOn(api, "getMediaInfo").mockResolvedValue({
      width: 2_000,
      height: 1_000,
      file_size: 1_000,
      extracted_date: "2025-07-04",
      metadata_source: "exif",
      media_type: "image",
    });
    vi.spyOn(api, "reviewOutcomes").mockRejectedValue({
      response: {
        status: 409,
        data: { detail: "Configuration changed after preview; generate it again" },
      },
    });
    renderReview(plan(), TEST_CONFIG, { onRerunPreview: rerun });
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(en("review.detail.provenanceSuperseded"))).toBeTruthy();
    expect(within(dialog).getByText("2000 × 1000")).toBeTruthy();
    expect(within(dialog).getByText("/out/2025/07/one.jpg")).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: en("review.detail.rebuildExplanation") }),
    );
    expect(rerun).toHaveBeenCalledOnce();
  });

  it("passes a segment's Configure anchor out of Review", async () => {
    const openSetting = vi.fn();
    const recorded: OutcomeProvenance = {
      date: {
        resolved_date: "2025-07-04",
        winning_source: "exif",
        candidates: [],
      },
      rules: {
        matched_tags: [],
        matched_routes: [],
        winning_route: null,
        route_folder: null,
      },
      categorization: {
        enabled: false,
        label: null,
        confidence: null,
        threshold: null,
        passed: null,
      },
      duplicate: {
        evaluated: false,
        status: "not_evaluated",
        match_kind: null,
        matched_path: null,
        perceptual_distance: null,
      },
      unit: null,
      path: [{ segment: "2025", decision: "date", detail: "year from exif" }],
    };
    vi.spyOn(api, "getMediaInfo").mockResolvedValue({
      width: null,
      height: null,
      file_size: 1_000,
      extracted_date: "2025-07-04",
      metadata_source: "exif",
      media_type: "image",
    });
    vi.spyOn(api, "reviewOutcomes").mockResolvedValue({
      config_fingerprint: "test",
      outcomes: [
        {
          source: "/in/one.jpg",
          resolved_date: "2025-07-04",
          candidates: [],
          provenance: recorded,
        },
      ],
      unavailable_paths: [],
    });
    renderReview(
      previewResult(
        item({
          source: "/in/one.jpg",
          destination: "/out/2025/one.jpg",
          provenance: recorded,
        }),
      ),
      TEST_CONFIG,
      { onOpenSetting: openSetting },
    );
    await screen.findByText("one.jpg");

    fireEvent.click(screen.getByText("one.jpg"));
    const dialog = await screen.findByRole("dialog");
    // The path line explains a part on request; the setting belongs to the
    // part being read, not to a card per segment.
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: `${en("review.detail.decision.date")} — year from exif`,
      }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: en("review.detail.openSettingFor", {
          decision: en("review.detail.decision.date"),
        }),
      }),
    );

    expect(openSetting).toHaveBeenCalledWith("setting-structure");
  });

  it("does not let a superseded file lookup replace the file navigated to", async () => {
    const oldInfo = deferred<Awaited<ReturnType<typeof api.getMediaInfo>>>();
    const oldOutcome = deferred<Awaited<ReturnType<typeof api.reviewOutcomes>>>();
    vi.spyOn(api, "getMediaInfo").mockImplementation((path) =>
      path === "/in/one.jpg"
        ? oldInfo.promise
        : Promise.resolve({
            width: 2_000,
            height: 1_000,
            file_size: 2_000,
            extracted_date: "2025-07-04",
            metadata_source: "exif",
            media_type: "image",
          }),
    );
    vi.spyOn(api, "reviewOutcomes").mockImplementation((paths) =>
      paths[0] === "/in/one.jpg"
        ? oldOutcome.promise
        : Promise.resolve({
            config_fingerprint: "test",
            outcomes: [],
            unavailable_paths: [],
          }),
    );
    renderReview(plan());
    await screen.findByText("one.jpg");
    fireEvent.click(screen.getByText("one.jpg"));

    const firstDialog = await screen.findByRole("dialog");
    fireEvent.click(within(firstDialog).getByRole("button", { name: en("review.detail.next") }));
    expect(within(await screen.findByRole("dialog")).getByText("two.jpg")).toBeTruthy();

    await act(async () => {
      oldInfo.resolve({
        width: 111,
        height: 111,
        file_size: 111,
        extracted_date: null,
        metadata_source: "none",
        media_type: "image",
      });
      oldOutcome.resolve({
        config_fingerprint: "old",
        outcomes: [],
        unavailable_paths: [],
      });
      await Promise.resolve();
    });

    const currentDialog = screen.getByRole("dialog");
    expect(within(currentDialog).getByText("two.jpg")).toBeTruthy();
    expect(within(currentDialog).queryByText("111 × 111")).toBeNull();
  });
});

describe("the Review Escape stack", () => {
  const duplicates = previewResult(
    item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
    item({ source: "/in/b.jpg", destination: "/out/_duplicates/b.jpg" }),
  );

  beforeEach(() => {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups:
        kind === "exact" ? [group("set-1", [{ path: "/in/a.jpg" }, { path: "/in/b.jpg" }])] : [],
      next_cursor: null,
      truncated: false,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  });

  it("dismisses a viewer, its comparison, and one expanded set in that order", async () => {
    renderReview(duplicates);
    const setHeader = await screen.findByRole("button", {
      name: new RegExp(en("review.stack.copies", { count: 2 })),
    });
    fireEvent.click(setHeader);
    fireEvent.click(rowCheckbox("a.jpg"));
    fireEvent.click(rowCheckbox("b.jpg"));
    fireEvent.click(screen.getByRole("button", { name: en("review.compare") }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: en("review.compare.title") })).getByRole("button", {
        name: "Look at a.jpg full screen",
      }),
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: en("review.compare.title") })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowCheckbox("b.jpg").checked).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("checkbox", { name: "b.jpg" })).toBeNull();
    // Collapsing was exactly one layer; the file selection remains for the next
    // dismissal rather than disappearing with it.
    expect(screen.getByRole("button", { name: en("review.clearSelection") })).toBeTruthy();
  });

  it("clears selection before search, while a focused search clears only itself", async () => {
    renderReview(duplicates);
    const setSelection = (await screen.findByRole("checkbox", {
      name: en("review.setSelection.toggle", { name: "a.jpg" }),
    })) as HTMLInputElement;
    fireEvent.click(setSelection);
    const search = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "a.jpg" } });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(setSelection.checked).toBe(false);
    expect(search.value).toBe("a.jpg");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(search.value).toBe("");

    fireEvent.click(setSelection);
    fireEvent.change(search, { target: { value: "a.jpg" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(setSelection.checked).toBe(true);
  });
});

describe("a folder's contents are grouped by where they land", () => {
  it("heads each subfolder with its own count", async () => {
    // The destination root is stripped, so the groups are the months rather
    // than the machine's own path segments.
    renderReview(
      previewResult(
        item({ source: "/in/a.jpg", destination: "/out/2025/07/a.jpg" }),
        item({ source: "/in/b.jpg", destination: "/out/2025/08/b.jpg" }),
      ),
      { ...TEST_CONFIG, target_directory: "/out/2025" },
    );
    await screen.findByText("a.jpg");

    // Scoped to the pane: the tree names the same folders, and the point is
    // that the contents beside it now say which of them each file goes to.
    const pane = within(screen.getByRole("group", { name: en("review.items") }));
    expect(pane.getByText("07")).toBeTruthy();
    expect(pane.getByText("08")).toBeTruthy();
  });
});

/**
 * `P2-DEDUP-D7` acceptance (2). Draft 2 of the plan omitted this, and the plan
 * itself calls it the actual UX defect: a list that stops at the page limit
 * looks exactly like a list that ended, so the surface tells someone they have
 * reviewed everything when they have reviewed the first page.
 */
describe("the truncation disclosure", () => {
  const result = previewResult(
    item({ source: "/in/dup-a.jpg", destination: "/out/2025/07/dup-a.jpg" }),
    item({ source: "/in/dup-b.jpg", destination: "/out/_duplicates/dup-b.jpg" }),
  );

  function serve(truncated: boolean) {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind, options) => ({
      groups:
        kind === "exact" && !options?.cursor
          ? [group("set-1", [{ path: "/in/dup-a.jpg" }, { path: "/in/dup-b.jpg" }])]
          : [],
      // A server that keeps handing back a cursor is what drives the hook into
      // its page bound, which is the state the disclosure exists for.
      next_cursor: truncated ? "more" : null,
      truncated,
      partial_index: false,
      kind: kind ?? "exact",
    }));
  }

  it("is shown when the list is not the whole library", async () => {
    serve(true);

    renderReview(result);

    expect(await screen.findByText(en("review.truncated.detail"), { exact: false })).toBeTruthy();
  });

  it("is absent when the list is complete", async () => {
    serve(false);

    renderReview(result);
    // Wait for something that only exists once the groups query has resolved,
    // or the absence below would hold simply because nothing had rendered yet.
    await screen.findByRole("button", {
      name: en("review.browse.showContents", { folder: en("review.browse.stays.undecided") }),
    });

    expect(screen.queryByText(en("review.truncated.detail"), { exact: false })).toBeNull();
  });
});

describe("the partial-index disclosure", () => {
  const result = previewResult(
    item({ source: "/in/dup-a.jpg", destination: "/out/2025/07/dup-a.jpg" }),
    item({ source: "/in/dup-b.jpg", destination: "/out/_duplicates/dup-b.jpg" }),
  );

  function serve(partial: boolean) {
    vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind, options) => ({
      groups:
        kind === "exact" && !options?.cursor
          ? [group("set-1", [{ path: "/in/dup-a.jpg" }, { path: "/in/dup-b.jpg" }])]
          : [],
      next_cursor: null,
      truncated: false,
      partial_index: partial,
      kind: kind ?? "exact",
    }));
  }

  it("warns when a scan could not read everything", async () => {
    // A stack drawn from a partly-read root may be missing copies that exist on
    // disk, and the person about to quarantine one needs to know before they do.
    serve(true);

    renderReview(result);

    expect(
      await screen.findByText(en("review.partialIndex.detail"), { exact: false }),
    ).toBeTruthy();
  });

  it("says nothing when the index is complete", async () => {
    serve(false);

    renderReview(result);
    await screen.findByRole("button", {
      name: en("review.browse.showContents", { folder: en("review.browse.stays.undecided") }),
    });

    expect(screen.queryByText(en("review.partialIndex.detail"), { exact: false })).toBeNull();
  });
});
