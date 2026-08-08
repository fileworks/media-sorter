import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True when running inside the Tauri desktop shell (the backend is auto-spawned)
 * rather than the browser dev server (backend started by hand). Drives copy that
 * would otherwise show developer-only instructions to users, and gates the
 * native folder picker.
 *
 * The probe is `__TAURI_IPC__`, the bridge `@tauri-apps/api` itself calls, and
 * not `__TAURI__`: that one only exists when `build.withGlobalTauri` is on, which
 * it is not here — so the old check was false even inside the packaged app, and
 * every native capability behind it silently did nothing.
 */
export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_IPC__" in window || "__TAURI_INTERNALS__" in window || "__TAURI__" in window);
