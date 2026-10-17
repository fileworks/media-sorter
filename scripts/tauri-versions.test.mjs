import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { crateVersions, mismatches, npmVersions } from "./tauri-versions.mjs";

const script = fileURLToPath(new URL("./tauri-versions.mjs", import.meta.url));

function npmLock(versions) {
  const packages = { "": { name: "media-sorter" } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function cargoLock(versions) {
  return [
    "version = 4",
    ...Object.entries(versions).flatMap(([name, list]) =>
      [list]
        .flat()
        .map(
          (version) =>
            `\n[[package]]\nname = "${name}"\nversion = "${version}"\n`,
        ),
    ),
  ].join("\n");
}

const aligned = {
  npm: {
    "@tauri-apps/api": "2.12.3",
    "@tauri-apps/cli": "2.12.2",
    "@tauri-apps/plugin-fs": "2.7.0",
    "@tauri-apps/plugin-shell": "2.5.0",
  },
  cargo: {
    tauri: "2.12.2",
    "tauri-build": "2.7.1",
    "tauri-plugin": "2.7.1",
    "tauri-plugin-fs": "2.7.0",
    "tauri-plugin-shell": "2.5.0",
  },
};

function check(npm, cargo) {
  return mismatches(npmVersions(npmLock(npm)), crateVersions(cargoLock(cargo)));
}

test("accepts a shared api/tauri minor and exactly matching plugins", () => {
  assert.deepEqual(check(aligned.npm, aligned.cargo), []);
});

test("rejects the plugin drift a grouped update locked in media-sorter #120", () => {
  const problems = check(aligned.npm, {
    ...aligned.cargo,
    "tauri-plugin-fs": "2.6.0",
  });

  assert.deepEqual(problems, [
    "@tauri-apps/plugin-fs 2.7.0 and tauri-plugin-fs 2.6.0 must be the same version",
  ]);
});

test("rejects an api package one minor ahead of the tauri crate", () => {
  const problems = check(
    { ...aligned.npm, "@tauri-apps/api": "2.13.0" },
    aligned.cargo,
  );

  assert.deepEqual(problems, [
    "@tauri-apps/api 2.13.0 and tauri 2.12.2 must share a minor version",
  ]);
});

test("rejects a plugin whose crate is missing or locked twice", () => {
  const missing = { ...aligned.cargo };
  delete missing["tauri-plugin-shell"];

  assert.deepEqual(check(aligned.npm, missing), [
    "tauri-plugin-shell: expected one locked crate version, found none",
  ]);
  assert.deepEqual(
    check(aligned.npm, {
      ...aligned.cargo,
      "tauri-plugin-fs": ["2.6.0", "2.7.0"],
    }),
    ["tauri-plugin-fs: expected one locked crate version, found 2"],
  );
});

test("ignores nested npm copies and the base tauri-plugin crate", () => {
  const lock = JSON.parse(npmLock(aligned.npm));
  lock.packages["node_modules/x/node_modules/@tauri-apps/api"] = {
    version: "1.0.0",
  };

  assert.deepEqual(
    mismatches(
      npmVersions(JSON.stringify(lock)),
      crateVersions(cargoLock(aligned.cargo)),
    ),
    [],
  );
});

test("exits non-zero with every problem when run against a repository", (context) => {
  const root = mkdtempSync(join(tmpdir(), "media-sorter-tauri-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("frontend/package-lock.json", npmLock(aligned.npm));
  write(
    "frontend/src-tauri/Cargo.lock",
    cargoLock({ ...aligned.cargo, "tauri-plugin-fs": "2.6.0" }),
  );

  const result = spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin-fs 2\.7\.0 and tauri-plugin-fs 2\.6\.0/);
});
