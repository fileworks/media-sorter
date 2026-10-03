/** Native development entry points; do not invoke Windows batch files as executables. */
import { existsSync } from "node:fs";
import path from "node:path";

export function npmInvocation(
  args,
  {
    platform = process.platform,
    executable = process.execPath,
    environment = process.env,
  } = {},
) {
  if (platform !== "win32") return { command: "npm", args };
  const cli =
    environment.npm_execpath ??
    path.join(
      path.dirname(executable),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
  if (!existsSync(cli))
    throw new Error(
      "npm CLI not found; install Node with npm or start through npm run dev:all",
    );
  return { command: executable, args: [cli, ...args] };
}

export function pythonInterpreter(venv, platform = process.platform) {
  return platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}
