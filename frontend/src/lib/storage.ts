/**
 * Browser storage that cannot break the app.
 *
 * Every call site here used to carry its own `try`/`catch` — six of them, in
 * five shapes, and the two most recent additions had none at all. A quota
 * error or a browser configured to deny site data would then escape from an
 * effect and take the whole screen down with it, over a preference. Storage is
 * a convenience: reads fall back, writes are best-effort, and nothing throws.
 */

export function readStored(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Denied or full: durable state is optional, the run is not.
  }
}

export function removeStored(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    // See `writeStored`.
  }
}

/**
 * Keep only `${prefix}${keep}` among the keys under `prefix`.
 *
 * Review state is written per plan id, and a new plan id is minted by every
 * dry run. Nothing removed the previous ones, so a long-lived install
 * accumulated a snapshot of every plan it had ever reviewed until the quota
 * ran out — at which point the *current* plan silently stopped persisting.
 * Exactly one plan is reviewable at a time, so exactly one snapshot is worth
 * keeping.
 */
export function dropScopedExcept(prefix: string, keep: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(prefix)) continue;
      if (keep !== null && key === `${prefix}${keep}`) continue;
      stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // See `writeStored`.
  }
}
