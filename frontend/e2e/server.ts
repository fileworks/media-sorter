/**
 * Where the browser suite's own dev server lives.
 *
 * Declared once and imported by both `vite.e2e.config.ts` and
 * `playwright.config.ts`, because the failure mode of these two disagreeing is
 * silent: the suite would go back to reusing whatever is on the dev port and
 * pass, having tested the developer's running app instead of its own.
 */

/** Not 1420. That one belongs to `npm run dev` and to Tauri's `devUrl`. */
export const E2E_PORT = 1421;

/**
 * The optimizer cache, kept apart from the dev server's `node_modules/.vite`.
 *
 * The port is only half of the separation. Vite keys its pre-bundled
 * dependency cache to `cacheDir`, not to the port, so two servers on two ports
 * still delete and rewrite one `deps/` directory. Vite re-optimizes by removing
 * `deps/`, building into a temporary sibling and renaming it into place; a
 * server killed inside that window — which is exactly what Playwright's
 * teardown does — leaves no `deps/` at all, and the next dev start has to
 * rebuild it. Two of them racing to do so deadlock, and `npm run dev` hangs
 * before it ever prints a banner.
 */
export const E2E_CACHE_DIR = "node_modules/.vite-e2e";

export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
