// @vitest-environment jsdom

/**
 * The two modes, driven through the rendered screen.
 *
 * The row model and the browse derivation are unit-tested next door; what needs
 * a screen is that the modes are wired to them — that a keeper chosen with the
 * keyboard reaches the run, that a bulk rule can still be argued with
 * afterwards, and that a comparison never fails silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { api } from "@/services/api";
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
} = { reviewedSets: [], outstandingSets: 0, proposedSets: 0, undecidedSets: 0 };

function renderReview(
  result: PreviewResult,
  config: Config = { ...TEST_CONFIG, duplicate_keeper_policy: "manual" },
  callbacks: { onOpenSetting?: (anchor: string) => void; onRerunPreview?: () => void } = {},
) {
  decisions = { reviewedSets: [], outstandingSets: 0, proposedSets: 0, undecidedSets: 0 };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ReviewScreen
          result={result}
          config={config}
          onOpenSetting={callbacks.onOpenSetting ?? (() => {})}
          onRerunPreview={callbacks.onRerunPreview ?? (() => {})}
          onDecisionsChange={(next) => {
            decisions = next;
          }}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
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
  fireEvent.click(screen.getByRole("radio", { name: en(`review.mode.${mode}`) }));
}

/** The tree's "make this folder the subject" control, by folder name. */
function showContents(folder: string) {
  fireEvent.click(
    screen.getByRole("button", { name: en("review.browse.showContents", { folder }) }),
  );
}

beforeEach(() => {
  // Review intentionally remembers its mode in the browser. Give every test a
  // fresh browser profile so one test ending in Resolve cannot make the next
  // test start there. Node versions differ on whether jsdom's localStorage is
  // available, so relying on the runner's implementation made this file pass
  // locally and fail in CI.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
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
    kind: "exact",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

    expect(screen.queryByText(en("review.band.noSets"))).toBeNull();
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
    expect(screen.queryByText(en("review.band.noSets"))).toBeNull();
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
    renderReview(result);

    const call = await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 1 })),
    });
    fireEvent.click(call);

    expect(screen.getByText(en("review.resolve.position", { index: 1, total: 1 }))).toBeTruthy();
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
      kind: kind ?? "exact",
    }));
  });

  it("keeps a copy by activating it, and the run is told", async () => {
    renderReview(result);
    await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 2 })),
    });
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
    await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 2 })),
    });
    switchTo("resolve");

    // Number keys keep a copy; arrows move between sets.
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "2" });

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/a.jpg",
      "/in/d.jpg",
    ]);
  });

  it("accepts a number shortcut while the Resolve mode radio retains focus", async () => {
    renderReview(result);
    await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 2 })),
    });
    const resolveMode = screen.getByRole("radio", {
      name: en("review.mode.resolve"),
    }) as HTMLInputElement;

    fireEvent.click(resolveMode);
    resolveMode.focus();
    fireEvent.keyDown(resolveMode, { key: "1" });

    expect(decisions.reviewedSets).toEqual([{ keep: "/in/a.jpg", demote: ["/in/b.jpg"] }]);
  });

  it("records 'not duplicates' as a binding decision instead of clearing the set", async () => {
    renderReview(result);
    await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 2 })),
    });
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
    await screen.findByRole("button", {
      name: new RegExp(en("review.band.undecided", { count: 2 })),
    });
    switchTo("resolve");
    fireEvent.click(screen.getByRole("button", { name: en("review.compare") }));

    fireEvent.keyDown(window, { key: "2" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(decisions.reviewedSets).toEqual([]);
  });

  it("applies a rule to every set it can decide, and each stays overridable", async () => {
    // Stated rather than inherited: the rule is what decides which copy wins,
    // so a test about the rule must not depend on the fixture's default.
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await screen.findByRole("button", {
      name: en("review.band.outstanding", { count: 2, proposed: 2, undecided: 0 }),
    });
    switchTo("resolve");

    // A rule has ranked both sets, but a proposal binds nothing.
    expect(decisions.reviewedSets).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: en("review.proposal.acceptAll", { count: 2 }) }),
    );
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

  it("accepts one proposal and re-proposes only the outstanding sets when the rule changes", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await screen.findByRole("button", {
      name: en("review.band.outstanding", { count: 2, proposed: 2, undecided: 0 }),
    });
    switchTo("resolve");

    fireEvent.click(screen.getByRole("button", { name: en("review.proposal.acceptOne") }));
    expect(decisions.reviewedSets.map((set) => set.keep)).toEqual(["/in/b.jpg"]);
    expect(decisions).toMatchObject({ outstandingSets: 1, proposedSets: 1, undecidedSets: 0 });

    fireEvent.change(screen.getByRole("combobox", { name: en("review.keepRule") }), {
      target: { value: "smallest" },
    });
    expect(decisions.reviewedSets.map((set) => set.keep)).toEqual(["/in/b.jpg"]);
    fireEvent.click(
      screen.getByRole("button", { name: en("review.proposal.acceptAll", { count: 1 }) }),
    );

    expect(decisions.reviewedSets.map((set) => set.keep).sort()).toEqual([
      "/in/b.jpg",
      "/in/d.jpg",
    ]);
    expect(decisions.outstandingSets).toBe(0);
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
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: en("review.setSelection.toggle", { name: "c.jpg" }),
      }),
    );
    switchTo("resolve");
    expect(screen.getByText(en("review.setSelection.count", { count: 2 }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: en("review.bulk.notDuplicates") }));
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

  it("ends with a way back rather than an empty frame", async () => {
    renderReview(result, { ...TEST_CONFIG, duplicate_keeper_policy: "largest" });
    await screen.findByRole("button", {
      name: en("review.band.outstanding", { count: 2, proposed: 2, undecided: 0 }),
    });
    switchTo("resolve");
    fireEvent.click(
      screen.getByRole("button", { name: en("review.proposal.acceptAll", { count: 2 }) }),
    );

    expect(screen.getByText(en("review.resolve.doneTitle"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en("review.resolve.backToBrowse") }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
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
      kind: kind ?? "exact",
    }));
  });

  it("never puts it in the queue, and says the reference is protected", async () => {
    renderReview(result);
    await screen.findByText(en("review.band.allDecided"));

    switchTo("resolve");
    expect(screen.getByText(en("review.resolve.doneTitle"))).toBeTruthy();
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

  it("compares a set against its own members even when the pane hides one", async () => {
    renderReview(result);
    await screen.findByRole("checkbox", { name: "unrelated.jpg" });

    // Narrow the pane so only one member of the set could possibly be visible.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a.jpg" } });
    switchTo("resolve");
    fireEvent.click(screen.getByRole("button", { name: en("review.compare") }));

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
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    fireEvent.keyDown(window, { key: "Escape" });
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
