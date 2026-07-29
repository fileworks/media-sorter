/**
 * Keeping the interface responsive while the backend does slow, real work.
 *
 * Two things make a desktop app feel frozen: rendering every message a busy
 * backend sends, and showing a percentage that has not moved for a minute. This
 * module fixes both without lying — updates are coalesced to a render budget,
 * and a stalled operation is reported as *still working* with the age of its
 * last signal rather than as a number that happens to be stuck.
 */

export interface ProgressSnapshot {
  phase: string;
  /** `null` while a root is still being enumerated — never a fake total. */
  total: number | null;
  current: number;
  bytesProcessed?: number | null;
  bytesTotal?: number | null;
  /** Monotonic sequence from the backend; out-of-order frames are dropped. */
  sequence: number;
  /** Epoch milliseconds of the last signal of any kind. */
  updatedAt: number;
  cancellationRequested?: boolean;
  cancellationObserved?: boolean;
  recoveryPhase?: string | null;
}

export interface ProgressView {
  phase: string;
  determinate: boolean;
  percentage: number | null;
  /** e.g. "1,204 of 8,900 files" or "1,204 files found so far". */
  countLabel: string;
  byteLabel: string | null;
  live: boolean;
  /** How long since anything changed, in whole seconds. */
  stalledForSeconds: number;
  cancelState: "none" | "requested" | "observed";
  etaConfidence: "none" | "low" | "high";
}

/** After this long without a change, the UI says "still working" explicitly. */
export const STALL_THRESHOLD_MS = 5_000;

/** No more than this many renders per second, however chatty the backend is. */
export const RENDER_INTERVAL_MS = 100;

function formatCount(value: number): string {
  return value.toLocaleString();
}

export function progressView(snapshot: ProgressSnapshot, now: number): ProgressView {
  const determinate = snapshot.total !== null && snapshot.total > 0;
  const stalledMs = Math.max(now - snapshot.updatedAt, 0);
  const percentage = determinate
    ? Math.min(100, Math.round((snapshot.current / (snapshot.total as number)) * 100))
    : null;

  const countLabel = determinate
    ? `${formatCount(snapshot.current)} of ${formatCount(snapshot.total as number)}`
    : `${formatCount(snapshot.current)} found so far`;

  const byteLabel =
    snapshot.bytesProcessed == null
      ? null
      : snapshot.bytesTotal == null
        ? `${formatCount(snapshot.bytesProcessed)} bytes`
        : `${formatCount(snapshot.bytesProcessed)} of ${formatCount(snapshot.bytesTotal)} bytes`;

  return {
    phase: snapshot.phase,
    determinate,
    percentage,
    countLabel,
    byteLabel,
    live: stalledMs < STALL_THRESHOLD_MS,
    stalledForSeconds: Math.floor(stalledMs / 1000),
    cancelState: snapshot.cancellationObserved
      ? "observed"
      : snapshot.cancellationRequested
        ? "requested"
        : "none",
    // An estimate needs a known total *and* enough progress to extrapolate from.
    etaConfidence: !determinate
      ? "none"
      : snapshot.current / (snapshot.total as number) > 0.1
        ? "high"
        : "low",
  };
}

/**
 * Drop frames that arrive out of order or too fast to render usefully.
 *
 * Returns the snapshot to render, or `null` to keep the current one. Terminal
 * information — a cancellation being observed, or reaching the total — is never
 * dropped, because those are the frames a user is waiting to see.
 */
export function coalesce(
  previous: ProgressSnapshot | null,
  incoming: ProgressSnapshot,
  lastRenderAt: number,
  now: number,
): ProgressSnapshot | null {
  if (previous !== null && incoming.sequence <= previous.sequence) {
    return null;
  }
  const important =
    previous === null ||
    incoming.phase !== previous.phase ||
    incoming.cancellationObserved !== previous.cancellationObserved ||
    incoming.recoveryPhase !== previous.recoveryPhase ||
    (incoming.total !== null && incoming.current >= incoming.total);
  if (important) {
    return incoming;
  }
  return now - lastRenderAt >= RENDER_INTERVAL_MS ? incoming : null;
}

/**
 * The reconnect point after a dropped connection.
 *
 * Resuming from the last sequence seen is what stops a reconnect from replaying
 * an entire operation's events — or, worse, from starting a second one.
 */
export function resumeFrom(snapshot: ProgressSnapshot | null): number {
  return snapshot?.sequence ?? 0;
}

export interface LivenessMessage {
  message: string;
  /** Whether to render a spinner rather than a bar. */
  indeterminate: boolean;
}

export function livenessMessage(view: ProgressView, activePath: string | null): LivenessMessage {
  if (view.cancelState === "requested") {
    return { message: "Stopping at the next safe point…", indeterminate: true };
  }
  if (!view.live) {
    const where = activePath ? ` Still working on ${activePath}.` : "";
    return {
      message: `No change for ${view.stalledForSeconds}s — this can happen on network drives.${where}`,
      indeterminate: true,
    };
  }
  if (!view.determinate) {
    return { message: `${view.phase}: ${view.countLabel}`, indeterminate: true };
  }
  return { message: `${view.phase}: ${view.countLabel}`, indeterminate: false };
}
