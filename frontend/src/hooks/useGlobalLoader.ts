import { useSyncExternalStore } from "react";
import { subscribeLoader, isLoaderActive } from "@/services/api";

/**
 * True while at least one genuinely long operation (analysis, preview, sort,
 * duplicate scan) is in flight. Operation hooks acquire the indicator before
 * starting and release it only after a terminal task state is observed.
 */
export function useGlobalLoader(): boolean {
  return useSyncExternalStore(subscribeLoader, isLoaderActive, isLoaderActive);
}
