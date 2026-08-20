// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReviewGroups } from "@/hooks/useReviewGroups";
import { CATALOG_BURST_GROUPS_AVAILABLE } from "@/lib/reviewWorkbench";
import { api, type ReviewGroup } from "@/services/api";

const crossScopeGroup = {
  group_id: "exact-cross-scope",
  kind: "exact",
  members: [{ observed_path: "/phone/only.jpg" }, { observed_path: "/camera/reference.jpg" }],
} as unknown as ReviewGroup;

describe("useReviewGroups", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches full catalog groups so skipped-source copies remain disclosed", async () => {
    const list = vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups: kind === "exact" ? [crossScopeGroup] : [],
      next_cursor: null,
      truncated: false,
      kind: kind ?? "exact",
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useReviewGroups(new Set(["/phone/only.jpg"]), new Set()), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tally?.outOfScope).toBe(1);
    expect(list).toHaveBeenCalledWith("exact", { limit: 200, cursor: null });
    expect(list).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludedRoots: expect.anything() }),
    );
  });

  /**
   * The opposite of what this asserted under `W0-UI-001`, exactly as that test
   * said it would: `P2-DEDUP-D3` landed the producer, so the catalog can answer
   * for burst stacks and the user's setting alone decides again.
   */
  it("requests burst stacks now that the catalog can produce them", async () => {
    const list = vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups: [],
      next_cursor: null,
      truncated: false,
      kind: kind ?? "exact",
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useReviewGroups(new Set(), new Set(), { bursts: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(CATALOG_BURST_GROUPS_AVAILABLE).toBe(true);
    expect(list.mock.calls.map(([kind]) => kind)).toEqual(["exact", "similar", "burst"]);
  });

  /**
   * `P2-DEDUP-D7`. The list used to stop after one page and look finished, so a
   * tally drawn from it described the first 200 stacks while claiming to
   * describe the library.
   */
  describe("paging", () => {
    function wrapper() {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
    }

    function pageOf(ids: string[], cursor: string | null) {
      return {
        groups: ids.map(
          (id) =>
            ({
              group_id: id,
              kind: "exact",
              members: [{ observed_path: `/in/${id}-a.jpg` }, { observed_path: `/in/${id}-b.jpg` }],
            }) as unknown as ReviewGroup,
        ),
        next_cursor: cursor,
        truncated: cursor !== null,
        kind: "exact",
      };
    }

    it("follows the cursor to the end of the list", async () => {
      const pages = [pageOf(["a", "b"], "cursor-1"), pageOf(["c"], null)];
      let call = 0;
      vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => {
        if (kind !== "exact") return pageOf([], null);
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return page;
      });

      const { result } = renderHook(() => useReviewGroups(), { wrapper: wrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.groups.map((group) => group.group_id)).toEqual(["a", "b", "c"]);
      expect(result.current.truncated).toBe(false);
    });

    it("passes the cursor it was given back to the server", async () => {
      const list = vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => {
        if (kind !== "exact") return pageOf([], null);
        return list.mock.calls.filter(([k]) => k === "exact").length === 1
          ? pageOf(["a"], "cursor-1")
          : pageOf(["b"], null);
      });

      const { result } = renderHook(() => useReviewGroups(), { wrapper: wrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(list).toHaveBeenCalledWith("exact", { limit: 200, cursor: "cursor-1" });
    });

    it("stops at the page bound and says the list is not the whole library", async () => {
      vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) =>
        kind === "exact" ? pageOf(["endless"], "always-more") : pageOf([], null),
      );

      const { result } = renderHook(() => useReviewGroups(), { wrapper: wrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.truncated).toBe(true);
    });

    it("keeps the tally and the list in agreement past one page", async () => {
      const first = Array.from({ length: 200 }, (_unused, index) => `g${index}`);
      const second = Array.from({ length: 60 }, (_unused, index) => `g${200 + index}`);
      let call = 0;
      vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => {
        if (kind !== "exact") return pageOf([], null);
        call += 1;
        return call === 1 ? pageOf(first, "cursor-1") : pageOf(second, null);
      });

      // `sets` counts sets this run acts on, so the scope has to contain them.
      const inScope = new Set(
        [...first, ...second].flatMap((id) => [`/in/${id}-a.jpg`, `/in/${id}-b.jpg`]),
      );

      const { result } = renderHook(() => useReviewGroups(inScope), { wrapper: wrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.groups).toHaveLength(260);
      // The tally is drawn from the same groups, so past one page it counts the
      // library rather than the first page of it.
      expect(result.current.tally?.sets).toBe(260);
      expect(result.current.truncated).toBe(false);
    });
  });
});
