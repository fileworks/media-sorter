// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePlanImpact } from "@/hooks/usePlanImpact";
import { api, type ReviewedSet } from "@/services/api";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const impact = {
  actionable_groups: 1,
  copy_count: 1,
  move_count: 0,
  quarantine_count: 0,
  quarantine_bytes: 0,
  skip_count: 0,
  source_mutations: 0,
  required_bytes: 10,
  conversion_without_originals: 0,
  companions_left_in_place: 0,
  embedded_tag_count: 0,
  unresolved_count: 0,
};

afterEach(() => vi.restoreAllMocks());

describe("usePlanImpact", () => {
  it("refetches when keep-all or the demoted membership changes", async () => {
    const request = vi.spyOn(api, "planImpact").mockResolvedValue(impact);
    const first: ReviewedSet[] = [{ keep: "/a.jpg", demote: ["/b.jpg"] }];
    const distinct: ReviewedSet[] = [{ keep: "/a.jpg", demote: [], keep_all: true }];

    const { rerender } = renderHook(
      ({ sets }: { sets: ReviewedSet[] }) => usePlanImpact("plan", ["root-b", "root-a"], sets),
      { initialProps: { sets: first }, wrapper: wrapper() },
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    rerender({ sets: distinct });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    rerender({ sets: [{ keep: "/a.jpg", demote: ["/c.jpg", "/b.jpg"] }] });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it("does not refetch for semantically identical ordering", async () => {
    const request = vi.spyOn(api, "planImpact").mockResolvedValue(impact);
    const { rerender } = renderHook(
      ({ roots, sets }: { roots: string[]; sets: ReviewedSet[] }) =>
        usePlanImpact("plan", roots, sets),
      {
        initialProps: {
          roots: ["root-b", "root-a"],
          sets: [
            { keep: "/z.jpg", demote: ["/z-2.jpg"] },
            { keep: "/a.jpg", demote: ["/c.jpg", "/b.jpg"] },
          ],
        },
        wrapper: wrapper(),
      },
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    rerender({
      roots: ["root-a", "root-b"],
      sets: [
        { keep: "/a.jpg", demote: ["/b.jpg", "/c.jpg"] },
        { keep: "/z.jpg", demote: ["/z-2.jpg"] },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
