import { useEffect, useRef, useState } from "react";

/**
 * `active`, but only once it has been true for longer than `delayMs`.
 *
 * For statuses that are almost always over before anybody could read them. The
 * review surface writes its plan state to the backend whenever *anything*
 * durable changes — a decision, but also which set the queue is on and which
 * dialog is open — so opening a detail dialog or stepping to the next duplicate
 * group starts a save that finishes in a handful of milliseconds. Rendering
 * that honestly produced a "Saving…" line that appeared and vanished inside one
 * frame budget, taking a row of layout with it, and a stage gate that closed
 * and reopened under the reader's cursor.
 *
 * A status nobody can read is not information. This reports a save only once it
 * is genuinely taking time, at which point saying so is worth the row it costs.
 *
 * Falling edges are immediate: when `active` goes false the flag clears at once,
 * so a slow save that finishes never leaves its notice behind.
 */
export function useDelayedFlag(active: boolean, delayMs = 600): boolean {
  const [elapsed, setElapsed] = useState(false);
  // Read in the effect below without making the effect depend on it: a changing
  // delay must not restart a timer that is already counting down.
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;

  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayRef.current);
    return () => clearTimeout(timer);
  }, [active]);

  return active && elapsed;
}
