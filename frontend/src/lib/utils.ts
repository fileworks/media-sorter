import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True when running inside the packaged Tauri desktop shell (the backend is
 * auto-spawned) rather than the browser dev server (backend started by hand).
 * Drives copy that would otherwise show developer-only instructions to users.
 */
export const isTauri = typeof window !== "undefined" && "__TAURI__" in window;
