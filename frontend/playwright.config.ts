import { defineConfig, devices } from "@playwright/test";

import { E2E_ORIGIN } from "./e2e/server";

/**
 * `P2-TEST-001` — browser-level accessibility verification.
 *
 * This suite exists for exactly what jsdom *structurally* cannot decide. The
 * vitest suite in `src/lib/__tests__/accessibility.test.tsx` already runs
 * axe-core over every screen and checks roles, names and keyboard reachability,
 * and it is the right place for those. It cannot check contrast, whether a
 * focused control is covered by something, or how large a tap target is,
 * because jsdom has no layout: every element is 0x0 at (0,0) and no colour is
 * ever composited. Those three are WCAG 1.4.3, 2.4.11 and 2.5.8, and they need
 * a real engine.
 *
 * The app runs against the Vite dev server, where `api.ts` falls back to
 * 127.0.0.1:8000 rather than Tauri IPC. The specs stub that origin, so no
 * backend is needed and the layout under test is deterministic.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /touch\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Pinned so a target-size or focus-obscured result is a property of the
        // layout rather than of whatever window the runner happened to open.
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "chromium-touch",
      testMatch: /touch\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 360, height: 800 },
        hasTouch: true,
      },
    },
  ],
  webServer: {
    // The suite brings its own server, on its own port, with its own optimizer
    // cache — see `e2e/server.ts`. It used to start a plain `vite` on 1420,
    // which is the dev server's port and, worse, the dev server's dependency
    // cache: a run here would either hijack a developer's running app or tear
    // a Vite down mid-optimization and leave `npm run dev` hanging with no
    // cache to start from.
    //
    // `--host 127.0.0.1` rather than the default: Vite binds `localhost`, which
    // on a CI image can resolve to ::1 only, while the readiness poll below is
    // IPv4. The server was up and the run still timed out.
    command: "npx vite --config vite.e2e.config.ts --host 127.0.0.1",
    url: E2E_ORIGIN,
    reuseExistingServer: !process.env.CI,
    // A cold runner pre-bundles dependencies on first start, which 2 minutes
    // does not reliably cover.
    timeout: 180_000,
    // Surface the server's own output, so the next failure of this kind says why
    // rather than only that it waited.
    stdout: "pipe",
    stderr: "pipe",
  },
});
