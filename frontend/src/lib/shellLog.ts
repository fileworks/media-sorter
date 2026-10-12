/**
 * Frontend failures in the launcher log.
 *
 * Without this, an uncaught error in the window leaves no trace in the file a
 * user is asked to send: the launcher only knew that the page loaded. Messages
 * are bounded and stripped of anything that looks like a credential or a
 * user path before they leave the page; the shell bounds them again.
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/utils";

export type ShellLogLevel = "info" | "warn" | "error";

const MAX_CHARS = 1500;

/** Remove tokens and file paths; keep the shape of the message. */
export function sanitizeForShellLog(message: string): string {
  return (
    message
      // `key=value`, `Key: Bearer value` and quoted JSON fields such as `"token":"value"`.
      .replace(
        /["']?(capability|token|api[_-]?key|authorization|password|secret|cookie)["']?\s*[=:]\s*(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        "$1=[REDACTED]",
      )
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
      .replace(/file:\/\/[^\s"')]+/gi, "<path>")
      // Drive paths with either separator, then UNC and `//server/share` paths.
      .replace(/\b[A-Za-z]:[\\/][^\s"']+/g, "<path>")
      .replace(/(^|[\s"'(=])(?:\\\\|\/\/)[^\s"')]+/g, "$1<path>")
      .replace(/(^|[\s"'(])\/(?:Users|home|Volumes|mnt|media|private)\/[^\s"')]+/g, "$1<path>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CHARS)
  );
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
  return typeof reason === "string" ? reason : (JSON.stringify(reason) ?? String(reason));
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
