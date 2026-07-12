import { useSyncExternalStore } from "react";
import { subscribeLoader, isLoaderActive } from "@/services/api";

/**
 * True while at least one genuinely long operation (analysis, preview, sort,
 * duplicate scan) is in flight. Driven by `withLoader` in the API client, so it
 * never reacts to config saves, validation, or background polling.
 */
export function useGlobalLoader(): boolean {
  return useSyncExternalStore(subscribeLoader, isLoaderActive, isLoaderActive);
}
