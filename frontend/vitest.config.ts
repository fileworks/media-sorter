import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest config for the pure-TS utility unit tests under src/lib/__tests__.
// Uses the same "@" → src alias as the app and a node environment (the
// formatters/path helpers need no DOM).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // The jsdom component tests render whole screens in parallel workers, so a
    // test that takes ~400ms alone can take several seconds under contention on
    // a loaded CI runner. Vitest's 5s default sits inside that spread and fails
    // on machine speed rather than on behaviour.
    testTimeout: 15_000,
  },
});
