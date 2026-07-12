import { defineConfig } from "vitest/config";
import path from "path";

// Vitest config for the pure-TS utility unit tests under src/lib/__tests__.
// Uses the same "@" → src alias as the app and a node environment (the
// formatters/path helpers need no DOM).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
