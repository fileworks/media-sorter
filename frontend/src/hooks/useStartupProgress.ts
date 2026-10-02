import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { startupSteps, type StartupStep } from "@/lib/startupProgress";
import { isTauri } from "@/lib/utils";
import { api } from "@/services/api";

export interface StartupProgress {
  /** The application has finished starting, and stays finished. */
  started: boolean;
  /** What each step of the start is doing, while it is still happening. */
  steps: StartupStep[];
  /** Why the start cannot continue, in one sentence. */
  failure: string | null;
}

/**
 * Whether the application has finished starting, and what it is doing if not.
 *
 * Starting is three steps, not one. The Tauri shell picks a free port at launch
 * and spawns the Python backend on it; the client asks the shell for that port
 * over IPC before it can address a single request; the backend then has to
 * answer a health check; and only then is there a configuration to draw a
 * screen from. The first of those happens *before* the first health request can
 * even be sent, which is why watching `health` alone left the longest part of a
 * cold start unexplained.
 *
 * The session resolves exactly once, in the API client's constructor, and is
 * never retried — a failed resolution is terminal until the window reloads — so
 * this observes it rather than polling, and seeds from `api.isReady` so a
 * remount does not re-announce a step that finished long ago.
 *
 * `started` latches. Without that, a health check blipping at minute ten would
 * throw the user out of a half-finished review and back onto a startup screen;
 * losing the backend mid-session is a different event, with its own banner, and
 * it does not un-start the application.
 */
export function useStartupProgress(input: {
  configReady: boolean;
  backendReady: boolean;
  backendFailed: boolean;
}): StartupProgress {
  const { t } = useI18n();
  const [sessionReady, setSessionReady] = useState(() => api.isReady);
  const [sessionFailure, setSessionFailure] = useState<string | null>(
    () => api.startupFailure?.message ?? null,
  );

  useEffect(() => {
    if (sessionReady || sessionFailure !== null) return;
    let live = true;
    void api
      .whenReady()
      .then(() => {
        if (live) setSessionReady(true);
      })
      .catch((cause: unknown) => {
        if (live) setSessionFailure(extractErrorMessage(cause, t("startup.sessionFailed")).message);
      });
    return () => {
      live = false;
    };
  }, [sessionFailure, sessionReady, t]);

  const startedRef = useRef(false);
  if (input.configReady && input.backendReady) startedRef.current = true;

  return {
    started: startedRef.current,
    steps: startupSteps(
      {
        sessionReady,
        sessionFailed: sessionFailure !== null,
        backendReady: input.backendReady,
        backendFailed: input.backendFailed,
        configReady: input.configReady,
        configFailed: false,
      },
      t,
    ),
    failure:
      sessionFailure ??
      (input.backendFailed ? t(isTauri ? "backend.lost" : "backend.browserLost") : null),
  };
}
