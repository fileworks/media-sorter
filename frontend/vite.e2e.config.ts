import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config";
import { E2E_CACHE_DIR, E2E_PORT } from "./e2e/server";

/**
 * The dev server the browser suite runs against — the app's own config, on its
 * own port, with its own dependency cache.
 *
 * Everything about the application under test is inherited, so the suite is
 * still exercising the real build. Only the two things that made the suite and
 * `npm run dev` collide are overridden; both live in `e2e/server.ts` with the
 * reasoning.
 */
export default mergeConfig(
  base,
  defineConfig({
    cacheDir: E2E_CACHE_DIR,
    server: {
      port: E2E_PORT,
      // Fail loudly rather than sliding onto 1422 and reporting green against a
      // server Playwright is not talking to.
      strictPort: true,
    },
  }),
);
