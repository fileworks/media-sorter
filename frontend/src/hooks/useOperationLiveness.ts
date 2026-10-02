/**
 * Turns polled task status into a view that never looks frozen.
 *
 * The backend already does its filesystem, hashing, and codec work off the
 * event loop; what the UI still owes the user is an honest reading of it — a
 * live count while a total is unknown, and an explicit "still working" once a
 * slow volume stops producing changes, instead of a percentage that sits still.
 */

import { useEffect, useRef, useState } from "react";

import {
  coalesce,
  livenessMessage,
  progressView,
  type LivenessMessage,
  type ProgressSnapshot,
  type ProgressView,
} from "@/lib/progressTransport";
import type { TaskProgress } from "@/types/api";

export interface OperationLiveness {
  view: ProgressView | null;
  message: LivenessMessage | null;
}

interface Options {
  /** Where the operation currently is, for the stalled message. */
  activePath?: string | null;
  cancellationRequested?: boolean;
  cancellationObserved?: boolean;
  /** Monotonic backend sequence, so out-of-order polls are dropped. */
  sequence?: number;
}

/** Re-evaluate liveness on this cadence even when no poll arrives. */
const TICK_MS = 1_000;

export function useOperationLiveness(
  progress: TaskProgress | null | undefined,
  options: Options = {},
): OperationLiveness {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastRenderRef = useRef(0);

  useEffect(() => {
    if (!progress) return;
    const incoming: ProgressSnapshot = {
      phase: progress.phase ?? "working",
      // A zero total means "not counted yet", not "nothing to do" — showing it
      // as 0 % is the frozen-bar bug this whole module exists to avoid.
      total: progress.total > 0 ? progress.total : null,
      current: progress.current,
      sequence: options.sequence ?? Date.now(),
      updatedAt: Date.now(),
      cancellationRequested: options.cancellationRequested,
      cancellationObserved: options.cancellationObserved,
    };
    setSnapshot((previous) => {
      const next = coalesce(previous, incoming, lastRenderRef.current, Date.now());
      if (next === null) return previous;
      lastRenderRef.current = Date.now();
      return next;
    });
  }, [progress, options.sequence, options.cancellationRequested, options.cancellationObserved]);

  useEffect(() => {
    if (snapshot === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  if (snapshot === null) {
    return { view: null, message: null };
  }
  const view = progressView(snapshot, now);
  return { view, message: livenessMessage(view, options.activePath ?? null) };
}
