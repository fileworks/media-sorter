// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReviewGroups } from "@/hooks/useReviewGroups";
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
});
