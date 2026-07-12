#!/usr/bin/env node
// Sync the released version (chosen by semantic-release from Conventional Commits)
// into every file that hardcodes the app/backend version, so the built installers
// AND the running backend all report the same version.
//
// Invoked from .releaserc.json via the @semantic-release/exec prepareCmd:
//     node scripts/sync-version.mjs <version>
// and runs from the repository root (semantic-release's cwd), so all paths below
// are relative to the repo root. The files updated here are committed back to main
// by the @semantic-release/git step (see `assets` in .releaserc.json) — keep the two
// lists in sync.
//
// Single source of truth per ecosystem:
//   • backend/app/_version.py  → backend version; pyproject.toml reads it via
//     hatchling's dynamic-version hook, so it is NOT patched separately.
//   • frontend/src-tauri/tauri.conf.json → names the .dmg / .msi / .exe and is the
//     version Tauri v1 stamps into the app.
//   • frontend/package.json (+ lockfile) → keep the npm manifest valid for `npm ci`.
//   • frontend/src-tauri/Cargo.toml (+ Cargo.lock) → the Rust crate version, kept in
//     lockstep so the workspace metadata doesn't drift. Patched textually (no cargo
//     invocation needed — the semantic-release runner has no Rust toolchain).

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(
    `sync-version: expected a semver version argument, got: ${JSON.stringify(version)}`,
  );
  process.exit(1);
}

/** Read a JSON file, mutate it, and write it back with 2-space indent + trailing newline. */
function patchJson(path, mutate) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  mutate(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`sync-version: ${path} -> ${version}`);
}

/**
 * Replace exactly the substring captured between two regex groups with `version`.
 * Throws if the pattern doesn't match — a structural change to one of these files
 * must fail the release loudly rather than silently leave a version unbumped.
 */
function patchText(path, pattern, label) {
  const before = readFileSync(path, "utf8");
  let matched = false;
  const after = before.replace(pattern, (_full, pre, post) => {
    matched = true;
    return `${pre}${version}${post}`;
  });
  if (!matched) {
    throw new Error(`sync-version: pattern for ${label} did not match in ${path}`);
  }
  writeFileSync(path, after);
  console.log(`sync-version: ${path} (${label}) -> ${version}`);
}

// Backend single source of truth: __version__ = "x.y.z" (pyproject derives from this).
patchText(
  "backend/app/_version.py",
  /(__version__ = ")[^"]*(")/,
  "__version__",
);

// Names the bundled installer (.dmg / .msi / .exe) and the Tauri app version.
patchJson("frontend/src-tauri/tauri.conf.json", (d) => {
  d.package.version = version;
});

// Keep the frontend npm manifest + lockfile in lockstep so `npm ci` stays valid.
patchJson("frontend/package.json", (d) => {
  d.version = version;
});
patchJson("frontend/package-lock.json", (d) => {
  d.version = version;
  if (d.packages && d.packages[""]) {
    d.packages[""].version = version;
  }
});

// Rust crate version. Cargo.toml: the first line-anchored `version = "..."`, which is
// the [package] version (dependency versions are inline `{ version = "..." }`, never
// line-anchored). Cargo.lock: the [[package]] entry for the workspace member
// media-sorter (its version line carries no checksum, so a textual bump is exactly
// what cargo would write).
patchText(
  "frontend/src-tauri/Cargo.toml",
  /(\[package\][\s\S]*?\nversion = ")[^"]*(")/,
  "[package].version",
);
patchText(
  "frontend/src-tauri/Cargo.lock",
  /(name = "media-sorter"\nversion = ")[^"]*(")/,
  "media-sorter lock entry",
);
