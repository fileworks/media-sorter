/**
 * Frontend failures in the launcher log.
 *
 * Without this, an uncaught error in the window leaves no trace in the file a
 * user is asked to send: the launcher only knew that the page loaded. Messages
 * are bounded and cut at anything that looks like a credential or a user
 * path before they leave the page; the shell bounds them again.
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/utils";

export type ShellLogLevel = "info" | "warn" | "error";

const MAX_CHARS = 1500;

/**
 * Where something private may begin. Finding the *end* of a path with spaces or
 * of an escaped secret is guesswork, so the message is cut at the first marker
 * instead: what precedes it is kept, everything after it is withheld.
 */
const SENSITIVE: readonly RegExp[] = [
  // A credential assigned or sent: `token=`, `"password":`, `Cookie:`, `Bearer x`.
  // Any name ending in a credential word counts (`access_token`, `client_secret`,
  // `set-cookie`), and quotes may arrive escaped from a serialized string.
  /(?:\\*["'])?[\w.-]*?(?:capability|token|api[_-]?key|authorization|password|passwd|secret|cookie|session)(?:\\*["'])?\s*[=:]/i,
  /\b(?:bearer|basic)\s+\S/i,
  // Paths: drive letters with either separator, `file:` URLs, UNC and
  // `//server` shares, home-relative and the usual user-data roots.
  /\b[A-Za-z]:[\\/]/,
  /\bfile:\//i,
  /(?<lead>^|[\s"'(=,[{])(?:\\\\|\/\/|~[\\/]|\/(?:Users|home|Volumes|mnt|media|private|run\/media|var\/folders)\/)/,
];

export const WITHHELD = "[withheld]";

/** Keep the message up to the first credential or path; withhold the rest. */
export function sanitizeForShellLog(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  let cut = flat.length;
  for (const pattern of SENSITIVE) {
    const match = pattern.exec(flat);
    if (match !== null) cut = Math.min(cut, match.index + (match.groups?.lead?.length ?? 0));
  }
  const kept = cut < flat.length ? `${flat.slice(0, cut).trimEnd()} ${WITHHELD}`.trim() : flat;
  return kept.slice(0, MAX_CHARS);
}

export function shellLog(level: ShellLogLevel, message: string): void {
  if (!isTauri) return;
  void invoke("frontend_log", { level, message: sanitizeForShellLog(message) }).catch(
    () => undefined,
  );
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    const frame = reason.stack?.split("\n")[1]?.trim() ?? "";
    return `${reason.name}: ${reason.message}${frame ? ` at ${frame}` : ""}`;
  }
  if (typeof reason === "string") return reason;
  // Arbitrary objects are never serialized: their fields are not ours to log,
  // and JSON escaping would hide credential names from the sanitizer. Only a
  // `message` string is kept, and it goes through the same boundary.
  if (typeof reason === "object" && reason !== null) {
    const message: unknown = (reason as { message?: unknown }).message;
    const kind = reason.constructor?.name || "Object";
    return typeof message === "string" ? `${kind}: ${message}` : `${kind} without a message`;
  }
  return String(reason);
}

/** Forward uncaught errors and unhandled rejections; call once at startup. */
export function installShellErrorLogging(target: Window = window): void {
  if (!isTauri) return;
  target.addEventListener("error", (event) => {
    shellLog("error", `uncaught ${describe(event.error ?? event.message)}`);
  });
  target.addEventListener("unhandledrejection", (event) => {
    shellLog("error", `unhandled rejection ${describe(event.reason)}`);
  });
}

export function logRenderCrash(error: Error, componentStack?: string | null): void {
  const where =
    componentStack
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  shellLog("error", `render crash ${describe(error)}${where ? ` in ${where}` : ""}`);
}
