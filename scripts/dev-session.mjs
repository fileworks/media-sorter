#!/usr/bin/env node

/**
 * Start development processes with one per-launch loopback API capability.
 * The token exists only in the child environment and rotates on every run.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(repository, "frontend");
const capability = randomBytes(32).toString("base64url");
const environment = {
  ...process.env,
  MEDIASORT_API_CAPABILITY: capability,
  VITE_MEDIASORT_API_CAPABILITY: capability,
};
const backendOnly = process.argv.includes("--backend-only");
const command = process.platform === "win32" ? "npm.cmd" : "npm";
const arguments_ = backendOnly
  ? ["run", "dev:backend"]
  : [
      "exec",
      "--",
      "concurrently",
      "-k",
      "-n",
      "backend,tauri",
      "-c",
      "cyan,magenta",
      "npm run dev:backend",
      "npm run tauri dev",
    ];

if (backendOnly) {
  process.stderr.write(
    `Development API capability for this launch: ${capability}\n` +
      "Send it as X-MediaSorter-Capability. Do not persist it.\n",
  );
}

const child = spawn(command, arguments_, {
  cwd: frontend,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`Could not start development session: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 130 : (code ?? 1);
});
