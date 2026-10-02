import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-version.mjs", import.meta.url));

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

test("syncs a release version through the Tauri v2 application manifests", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-sorter-version-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  write(root, "backend/app/_version.py", '__version__ = "1.3.0"\n');
  write(
    root,
    "frontend/src-tauri/tauri.conf.json",
    `${JSON.stringify({ $schema: "https://schema.tauri.app/config/2", version: "1.3.0" }, null, 2)}\n`,
  );
  write(root, "frontend/package.json", `${JSON.stringify({ version: "1.3.0" }, null, 2)}\n`);
  write(
    root,
    "frontend/package-lock.json",
    `${JSON.stringify({ version: "1.3.0", packages: { "": { version: "1.3.0" } } }, null, 2)}\n`,
  );
  write(root, "frontend/src-tauri/Cargo.toml", '[package]\nname = "media-sorter"\nversion = "1.3.0"\n');
  write(
    root,
    "frontend/src-tauri/Cargo.lock",
    '[[package]]\nname = "media-sorter"\nversion = "1.3.0"\n',
  );

  const result = spawnSync(process.execPath, [script, "1.4.0"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(root, "frontend/src-tauri/tauri.conf.json").version, "1.4.0");
  assert.equal(readJson(root, "frontend/package.json").version, "1.4.0");
  assert.equal(readJson(root, "frontend/package-lock.json").version, "1.4.0");
  assert.equal(
    readJson(root, "frontend/package-lock.json").packages[""].version,
    "1.4.0",
  );
  assert.match(readFileSync(join(root, "backend/app/_version.py"), "utf8"), /1\.4\.0/);
  assert.match(readFileSync(join(root, "frontend/src-tauri/Cargo.toml"), "utf8"), /1\.4\.0/);
  assert.match(readFileSync(join(root, "frontend/src-tauri/Cargo.lock"), "utf8"), /1\.4\.0/);
});

test("fails loudly when the Tauri version field no longer matches the v2 schema", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-sorter-version-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  write(root, "backend/app/_version.py", '__version__ = "1.3.0"\n');
  write(root, "frontend/src-tauri/tauri.conf.json", '{"productName":"MediaSorter"}\n');

  const result = spawnSync(process.execPath, [script, "1.4.0"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected the Tauri v2 root-level version/);
});
