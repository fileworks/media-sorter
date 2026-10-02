import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import type { RootCard, RootState } from "@/lib/sourcesStage";
import { api } from "@/services/api";
import type { DirectoryListing } from "@/services/api";

/**
 * Probe every configured root through the endpoint that also lists folders.
 *
 * A card used to claim "ready" purely because a scan had happened, so a run
 * could be configured against a folder that had been unplugged, renamed or made
 * read-only. Probing through `/api/fs/list` means a card's state and the
 * destination check the sort performs come from the same answer.
 */
export function useRootProbes(cards: RootCard[]): Record<string, RootState> {
  const paths = useMemo(() => {
    const unique = new Set(cards.map((card) => card.path).filter((path) => path.trim() !== ""));
    return [...unique].sort();
  }, [cards]);

  const results = useQueries({
    queries: paths.map((path) => ({
      queryKey: ["fs", "list", path],
      queryFn: () => api.listDirectory(path),
      // A folder does not change often, and this fires for every card.
      staleTime: 30_000,
      retry: false,
    })),
  });

  return useMemo(() => {
    const byPath = new Map<string, (typeof results)[number]>();
    paths.forEach((path, index) => byPath.set(path, results[index]));

    const states: Record<string, RootState> = {};
    for (const card of cards) {
      const probe = card.path.trim() === "" ? undefined : byPath.get(card.path);
      states[card.rootId] = toState(card, probe);
    }
    return states;
  }, [cards, paths, results]);
}

function toState(
  card: RootCard,
  probe: { isPending: boolean; data?: DirectoryListing; error: unknown } | undefined,
): RootState {
  if (probe === undefined) return "unknown";
  if (probe.isPending) return "checking";
  if (probe.error) {
    // 404 and 400 both mean "this is not a folder that exists"; anything else
    // is a fault on our side, and claiming the folder is broken would be a lie.
    const status = (probe.error as { response?: { status?: number } }).response?.status;
    return status === 404 || status === 400 ? "missing" : "unknown";
  }
  const listing = probe.data;
  if (!listing) return "unknown";
  if (!listing.readable) return "unreadable";
  if (card.role === "destination" && !listing.writable) return "not_writable";
  return "ready";
}
