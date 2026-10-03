import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { npmInvocation, pythonInterpreter } from "./dev-process.mjs";

test("Windows npm launches through Node with literal arguments and spaced paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mediasort dev "));
  try {
    const cli = path.join(root, "npm fixture.cjs");
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const args = ["exec", "--", "npm run dev:backend", "literal & argument"];
    const invocation = npmInvocation(args, {
      platform: "win32",
      executable: process.execPath,
      environment: { npm_execpath: cli },
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows chooses Scripts/python.exe and POSIX chooses bin/python", () => {
  const root = path.resolve("backend/.venv");
  assert.equal(
    pythonInterpreter(root, "win32"),
    path.join(root, "Scripts", "python.exe"),
  );
  assert.equal(
    pythonInterpreter(root, "linux"),
    path.join(root, "bin", "python"),
  );
  assert.equal(
    pythonInterpreter(root, "darwin"),
    path.join(root, "bin", "python"),
  );
});

test("missing Windows npm reports a setup error before launching a child", () => {
  assert.throws(
    () =>
      npmInvocation([], {
        platform: "win32",
        executable: "/missing/node.exe",
        environment: {},
      }),
    /npm.*not found/,
  );
});
