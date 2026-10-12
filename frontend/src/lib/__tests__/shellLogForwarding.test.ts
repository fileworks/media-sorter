import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn<(command: string, payload: { message: string }) => Promise<void>>(() => Promise.resolve()),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/utils", () => ({ isTauri: true }));

import { installShellErrorLogging, WITHHELD } from "@/lib/shellLog";

/** What the window forwarded to the launcher's `frontend_log` command. */
function forwarded(): string[] {
  return invoke.mock.calls.map(([, payload]) => payload.message);
}

describe("installShellErrorLogging", () => {
  let target: EventTarget;

  beforeEach(() => {
    invoke.mockClear();
    target = new EventTarget();
    installShellErrorLogging(target as unknown as Window);
  });

  function reject(reason: unknown) {
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  }

  // F1-004 re-check: a rejection object carrying a credential-bearing JSON
  // string must not reach the log, however it is nested.
  it.each([
    { message: 'failed {"token":"SYNTHETIC-SECRET"}' },
    { message: "failed", detail: { access_token: "SYNTHETIC-SECRET" } },
    { headers: { Authorization: "Bearer SYNTHETIC-SECRET" } },
    { path: "C:/Users/Example/My Pictures/personal.jpg" },
  ])("forwards no private value from a rejected object %#", (reason) => {
    reject(reason);

    expect(forwarded()).toHaveLength(1);
    expect(forwarded()[0]).not.toMatch(/SECRET|example|personal/i);
  });

  it("keeps the kind and a safe message of a rejected object", () => {
    reject({ message: "request timed out" });
    reject({ status: 500 });

    expect(forwarded()).toEqual([
      "unhandled rejection Object: request timed out",
      "unhandled rejection Object without a message",
    ]);
  });

  it("cuts a rejected object's message at its first credential", () => {
    reject({ message: 'failed {"token":"SYNTHETIC-SECRET"}' });

    expect(forwarded()[0]).toBe(`unhandled rejection Object: failed { ${WITHHELD}`);
  });
});
