/**
 * The order in which starting actually happens, as four answerable states.
 *
 * Kept out of the component so the sequencing rule — at most one step running,
 * nothing running behind a failure, nothing after an unmet precondition — is
 * testable without a DOM, and so the screen stays presentation.
 */

export type StartupStepState = "pending" | "running" | "done" | "failed";

export interface StartupStep {
  id: string;
  label: string;
  detail: string;
  state: StartupStepState;
}

/**
 * Resolve the four steps from what is observable, in order.
 *
 * Order matters and is not cosmetic: each step is a precondition for the next,
 * so at most one is ever `running` and nothing after a failure claims to be in
 * progress.
 */
export function startupSteps(
  input: {
    sessionReady: boolean;
    sessionFailed: boolean;
    backendReady: boolean;
    backendFailed: boolean;
    configReady: boolean;
    configFailed: boolean;
    restoreReady: boolean;
    restoreFailed: boolean;
  },
  t: (key: string) => string,
): StartupStep[] {
  const session: StartupStepState = input.sessionFailed
    ? "failed"
    : input.sessionReady
      ? "done"
      : "running";
  const backend: StartupStepState =
    session !== "done"
      ? "pending"
      : input.backendFailed
        ? "failed"
        : input.backendReady
          ? "done"
          : "running";
  const config: StartupStepState =
    backend !== "done"
      ? "pending"
      : input.configFailed
        ? "failed"
        : input.configReady
          ? "done"
          : "running";
  const restore: StartupStepState =
    config !== "done"
      ? "pending"
      : input.restoreFailed
        ? "failed"
        : input.restoreReady
          ? "done"
          : "running";

  return [
    {
      id: "session",
      label: t("startup.step.session"),
      detail: t("startup.step.session.detail"),
      state: session,
    },
    {
      id: "backend",
      label: t("startup.step.backend"),
      detail: t("startup.step.backend.detail"),
      state: backend,
    },
    {
      id: "config",
      label: t("startup.step.config"),
      detail: t("startup.step.config.detail"),
      state: config,
    },
    {
      id: "restore",
      label: t("startup.step.restore"),
      detail: t("startup.step.restore.detail"),
      state: restore,
    },
  ];
}
