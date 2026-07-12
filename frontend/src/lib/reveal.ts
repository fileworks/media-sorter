/**
 * File-path helpers for the media preview views.
 *
 * Both functions are resilient by design: when the app runs outside Tauri (e.g.
 * a plain browser during `vite` dev), the Tauri invocations simply fail and are
 * caught, so callers can fire-and-forget without guarding for it.
 *
 * Static imports are used here (rather than dynamic) because these Tauri modules
 * are already in the main bundle via api.ts — dynamic imports would cause a Vite
 * "will not move module into another chunk" warning with no benefit.
 */

import { writeText } from "@tauri-apps/api/clipboard";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/shell";

/**
 * Copy *path* to the system clipboard.
 *
 * Prefers Tauri's clipboard API (which works without focus/permission quirks),
 * falling back to the browser Clipboard API when not running under Tauri.
 */
export async function copyPath(path: string): Promise<void> {
  try {
    await writeText(path);
    return;
  } catch {
    // Not under Tauri (or clipboard plugin unavailable) — fall through.
  }
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // Clipboard genuinely unavailable; nothing more we can do.
  }
}

/**
 * Reveal *path* in the OS file manager (Finder / Explorer / file browser).
 *
 * Delegates to the custom `reveal_path` Tauri command. Errors (including
 * "running in a browser") are swallowed so the UI never breaks.
 */
export async function revealPath(path: string): Promise<void> {
  try {
    await invoke("reveal_path", { path });
  } catch {
    // Not under Tauri, or the reveal failed — best effort only.
  }
}

/**
 * Open *url* in the user's default browser.
 *
 * Uses the Tauri shell `open()` when available (respects the allowlist),
 * falling back to `window.open` for browser-based dev. The URL is validated
 * client-side before being passed to Tauri so a malformed API response can
 * never trigger an arbitrary open.
 */
export async function openExternal(url: string): Promise<void> {
  // Safety: only open https:// URLs — never file:// or arbitrary schemes.
  if (!url.startsWith("https://")) return;
  try {
    await open(url);
    return;
  } catch {
    // Not under Tauri — fall through to browser.
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
