#!/usr/bin/env node
/** Start the locked backend environment on Windows, macOS or Linux. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonInterpreter } from "./dev-process.mjs";

const backend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../backend",
);
const python = pythonInterpreter(path.join(backend, ".venv"));
if (!existsSync(python)) {
  process.stderr.write(
    "Backend environment is missing; run uv sync --project backend --locked --all-extras --dev from the repo root.\n",
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--reload",
      "--timeout-graceful-shutdown",
      "3",
    ],
    {
      cwd: backend,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(
      `Could not start development backend: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 130 : (code ?? 1);
  });
}
