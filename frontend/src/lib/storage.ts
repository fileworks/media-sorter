/**
 * Browser storage that cannot break the app.
 *
 * Every call site here used to carry its own `try`/`catch` — six of them, in
 * five shapes, and the two most recent additions had none at all. A quota
 * error or a browser configured to deny site data would then escape from an
 * effect and take the whole screen down with it, over a preference. Storage is
 * a convenience: reads fall back, writes are best-effort, and nothing throws.
 */

function browserStorage(): Storage | null {
  try {
    // Node 26 exposes an experimental global `localStorage` getter that emits
    // a warning when read without `--localstorage-file`. Persistence is only
    // meaningful when a browser Window exists, so never probe that Node global.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (descriptor && "value" in descriptor) return descriptor.value as Storage;
    const nodeProcess = (
      globalThis as typeof globalThis & { process?: { versions?: { node?: string } } }
    ).process;
    // Vitest's jsdom Window inherits Node's accessor. Skip it; tests that need
    // storage install the explicit data descriptor handled above.
    if (nodeProcess?.versions?.node) return null;
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): boolean {
  try {
    const storage = browserStorage();
    if (storage === null) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStored(key: string): void {
  try {
    browserStorage()?.removeItem(key);
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
    const storage = browserStorage();
    if (storage === null) return;
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(prefix)) continue;
      if (keep !== null && key === `${prefix}${keep}`) continue;
      stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // See `writeStored`.
  }
}
