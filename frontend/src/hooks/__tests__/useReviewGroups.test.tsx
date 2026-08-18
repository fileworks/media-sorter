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
    expect(list).toHaveBeenCalledWith("exact", { limit: 200 });
    expect(list).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludedRoots: expect.anything() }),
    );
  });

  /**
   * `burst_groups` reads perceptual signatures and media facts out of the
   * catalog, and nothing in production writes either. Requesting the kind makes
   * the catalog scan for a result that is empty by construction, and makes the
   * Review surface look like it consulted a producer that does not exist.
   *
   * The user's setting is still passed in and still read — it is simply not
   * sufficient on its own. `P2-DEDUP-D3` lands the producer and `P2-DEDUP-D9`
   * flips `CATALOG_BURST_GROUPS_AVAILABLE`, at which point this asserts the
   * opposite and the setting alone decides again.
   */
  it("does not request burst stacks while the catalog has no producer for them", async () => {
    const list = vi.spyOn(api, "listReviewGroups").mockImplementation(async (kind) => ({
      groups: [],
      next_cursor: null,
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

    expect(CATALOG_BURST_GROUPS_AVAILABLE).toBe(false);
    expect(list.mock.calls.map(([kind]) => kind)).toEqual(["exact", "similar"]);
    expect(list).not.toHaveBeenCalledWith("burst", expect.anything());
  });
});
