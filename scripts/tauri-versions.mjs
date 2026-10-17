#!/usr/bin/env node
// Fail when the locked Tauri npm packages and Rust crates drift apart.
//
// Tauri requires the same minor version of `@tauri-apps/api` and the `tauri`
// crate, and the exact same version of each `@tauri-apps/plugin-*` package and
// its `tauri-plugin-*` crate. npm and crates.io publish independently, so a
// grouped dependency update can lock one side before the other has passed the
// release-age soak. This check is what lets that update automerge safely:
// https://v2.tauri.app/develop/updating-dependencies/
//
//     node scripts/tauri-versions.mjs [repository-root]
//
// Reads the lockfiles textually, so the runner needs no Rust toolchain.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Locked top-level `@tauri-apps/*` versions from an npm v3 lockfile. */
export function npmVersions(lockText) {
  const versions = new Map();
  for (const [path, entry] of Object.entries(
    JSON.parse(lockText).packages ?? {},
  )) {
    const match = /^node_modules\/(@tauri-apps\/[^/]+)$/.exec(path);
    if (match && entry.version) versions.set(match[1], entry.version);
  }
  return versions;
}

/** Locked `tauri*` crate versions from Cargo.lock; several versions of one crate are all kept. */
export function crateVersions(lockText) {
  const versions = new Map();
  for (const block of lockText.split(/^\[\[package\]\]$/m)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (!name?.startsWith("tauri") || !version) continue;
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

const minor = (version) => version.split(".").slice(0, 2).join(".");

/** Every mismatch between the two lockfiles, as a readable sentence. */
export function mismatches(npm, crates) {
  const problems = [];
  const one = (crate) => {
    const versions = crates.get(crate) ?? [];
    if (versions.length !== 1) {
      problems.push(
        `${crate}: expected one locked crate version, found ${versions.length || "none"}`,
      );
      return undefined;
    }
    return versions[0];
  };

  const api = npm.get("@tauri-apps/api");
  if (!api)
    problems.push("@tauri-apps/api: not locked in frontend/package-lock.json");
  const tauri = one("tauri");
  if (api && tauri && minor(api) !== minor(tauri)) {
    problems.push(
      `@tauri-apps/api ${api} and tauri ${tauri} must share a minor version`,
    );
  }

  for (const [name, version] of npm) {
    const plugin = /^@tauri-apps\/plugin-(.+)$/.exec(name)?.[1];
    if (!plugin) continue;
    const crate = one(`tauri-plugin-${plugin}`);
    if (crate && crate !== version) {
      problems.push(
        `${name} ${version} and tauri-plugin-${plugin} ${crate} must be the same version`,
      );
    }
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = process.argv[2] ?? ".";
  const problems = mismatches(
    npmVersions(readFileSync(join(root, "frontend/package-lock.json"), "utf8")),
    crateVersions(
      readFileSync(join(root, "frontend/src-tauri/Cargo.lock"), "utf8"),
    ),
  );
  if (problems.length) {
    for (const problem of problems) console.error(`tauri-versions: ${problem}`);
    process.exit(1);
  }
  console.log("tauri-versions: npm packages and crates are aligned");
}
