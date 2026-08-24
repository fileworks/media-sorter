const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  RELEASE_HEADER,
  assertPreparedRelease,
  assertReleaseable,
  assertReleaseTag,
  assertSourceAtLatestTag,
  bumpLevel,
  whatBump,
} = require("./releaseability.cjs");

const GENERATED_RELEASE_FILES = [
  "CHANGELOG.md",
  "backend/app/_version.py",
  "frontend/package.json",
  "frontend/package-lock.json",
  "frontend/src-tauri/Cargo.toml",
  "frontend/src-tauri/Cargo.lock",
  "frontend/src-tauri/tauri.conf.json",
];

function versionFile(path, version, { released = false } = {}) {
  if (path.endsWith("package.json") && !path.endsWith("package-lock.json")) {
    return JSON.stringify(
      { name: "media-sorter", version, private: true, scripts: { test: "vitest" } },
      null,
      2,
    ) + "\n";
  }
  if (path.endsWith("package-lock.json")) {
    return (
      JSON.stringify(
        {
          name: "media-sorter",
          version,
          lockfileVersion: 3,
          packages: {
            "": { name: "media-sorter", version },
            "node_modules/safe": { version: "1.0.0" },
          },
        },
        null,
        2,
      ) + "\n"
    );
  }
  if (path.endsWith("tauri.conf.json")) {
    return (
      JSON.stringify({ version, app: { security: { csp: "default-src 'self'" } } }, null, 2) +
      "\n"
    );
  }
  if (path.endsWith("Cargo.toml")) {
    return `[package]\nname = "media-sorter"\nversion = "${version}"\n\n[dependencies]\ntauri = "2"\n`;
  }
  if (path.endsWith("Cargo.lock")) {
    return `version = 4\n\n[[package]]\nname = "media-sorter"\nversion = "${version}"\ndependencies = [\n "tauri",\n]\n`;
  }
  if (path.endsWith("_version.py")) {
    return `"""version"""\n\n__version__ = "${version}"\n`;
  }
  if (path === "CHANGELOG.md") {
    const old = "## [1.4.4] - 2026-08-13\n\n* fix: prior release\n";
    return released
      ? `${RELEASE_HEADER}\n\n## [1.5.0] (2026-08-22)\n\n* feat: reviewed work\n\n${old}`
      : `${RELEASE_HEADER}\n\n${old}`;
  }
  throw new Error(`unexpected version file: ${path}`);
}

const releasedVersionFile = (path) => versionFile(path, "1.5.0", { released: true });
const parentVersionFile = (path) => versionFile(path, "1.4.4");
const generatedReleaseSection = () =>
  "## [1.5.0] (2026-08-22)\n\n* feat: reviewed work";
const renderer = join(__dirname, "render-release-changelog.mjs");

function runGit(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function generatedReleaseGit(...args) {
  const command = args.join(" ");
  if (command === "describe --tags --exact-match") return "v1.5.0";
  if (command === "cat-file -t refs/tags/v1.5.0") return "tag";
  if (command === "rev-parse v1.5.0^{}" || command === "rev-parse HEAD") return "release";
  if (command === "log -1 --format=%s HEAD") return "chore(release): v1.5.0";
  if (command === "diff --name-only HEAD^..HEAD") return GENERATED_RELEASE_FILES.join("\n");
  if (command === "diff --summary HEAD^..HEAD") return "";
  if (command === "describe --tags --match=v* --abbrev=0 HEAD^") return "v1.4.4";
  if (command === "show -s --format=%cs HEAD") return "2026-08-22";
  if (command === "diff --name-only v1.4.4..HEAD^") return "backend/app/safety.py";
  if (command === "log --format=%s%n%b%x1e v1.4.4..HEAD^") {
    return "feat(safety): preserve rewritten sources at unlink\x1e";
  }
  if (command === "merge-base --is-ancestor HEAD refs/remotes/origin/main") return "";
  if (
    command ===
    "describe --tags --match=v* --abbrev=0 refs/remotes/origin/main"
  ) {
    return "v1.5.0";
  }
  throw new Error(`unexpected git call: ${command}`);
}

test("aggregated reviewed feature records produce the minor bump for v1.5.0", () => {
  assert.equal(
    bumpLevel(["Wave 3: reviewed changes\n* feat(review): preserve decisions\n* fix(safety): recheck sources"]),
    1,
  );
});

test("documentation-only history remains deliberately release-free", () => {
  assert.equal(bumpLevel(["docs: clarify the runbook"]), null);
});

test("prose containing fix labels is not a conventional record", () => {
  assert.equal(bumpLevel(["chore: product rewrite\nThis does not fix: the old note"]), null);
  assert.equal(bumpLevel(["docs: notes\nThe prior fix: remains documented"]), null);
});

test("fenced and indented conventional examples do not manufacture a bump", () => {
  assert.equal(bumpLevel(["docs: examples\n```text\nfeat: example\n```\n    fix: code sample"]), null);
  assert.equal(bumpLevel(["docs: example\n> BREAKING CHANGE: illustrative only"]), null);
});

test("shorter nested markers do not close longer Markdown fences", () => {
  assert.equal(bumpLevel(["docs: examples\n````text\n```\nfeat: example\n````"]), null);
  assert.equal(bumpLevel(["docs: examples\n~~~~text\n~~~\nfix: example\n~~~~"]), null);
});

test("release-it receives a conventional recommended-bump shape", () => {
  assert.deepEqual(whatBump([{ header: "Wave 3", body: "* feat(ui): improve review" }]), {
    level: 1,
    reason: "Reviewed conventional commit records",
  });
});

test("material history with no next version fails closed", () => {
  const fakeGit = (...args) => {
    if (args[0] === "describe") return "v1.4.4";
    if (args[0] === "diff") return "backend/app/new_feature.py\n";
    if (args[0] === "log") return "chore: land an unclassified product change\x1e";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.throws(() => assertReleaseable(fakeGit), /material changes.*no conventional next version/);
});

test("every source version must match the latest tag before generation", () => {
  const fakeGit = (...args) =>
    args[0] === "describe" ? "v1.4.4" : (() => { throw new Error(args.join(" ")); })();
  for (const mismatched of GENERATED_RELEASE_FILES.filter((path) => path !== "CHANGELOG.md")) {
    const read = (path) => versionFile(path, path === mismatched ? "9.9.9" : "1.4.4");
    assert.throws(() => assertSourceAtLatestTag(fakeGit, read), /source versions/, mismatched);
  }
});

test("prepared release bytes are validated before commit, tag, or push", () => {
  const preparedGit = (...args) => {
    const command = args.join(" ");
    if (command === "describe --tags --match=v* --abbrev=0 HEAD") return "v1.4.4";
    if (command === "diff --name-only v1.4.4..HEAD") return "backend/app/safety.py";
    if (command === "log --format=%s%n%b%x1e v1.4.4..HEAD") {
      return "feat(safety): reviewed work\x1e";
    }
    if (command === "diff --name-only HEAD") return GENERATED_RELEASE_FILES.join("\n");
    if (command === "diff --summary HEAD") return "";
    throw new Error(`unexpected git call: ${command}`);
  };

  assert.equal(
    assertPreparedRelease(
      "1.5.0",
      preparedGit,
      releasedVersionFile,
      parentVersionFile,
      generatedReleaseSection,
      "2026-08-22",
    ),
    "1.5.0",
  );
});

test("documentation-only history does not force a release", () => {
  const fakeGit = (...args) => {
    if (args[0] === "describe") return "v1.4.4";
    if (args[0] === "diff") return "docs/release.md\n";
    if (args[0] === "log") return "docs: clarify the runbook\x1e";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.equal(assertReleaseable(fakeGit), null);
});

test("documentation-only files stay release-free even with a conventional example", () => {
  const fakeGit = (...args) => {
    if (args[0] === "describe") return "v1.4.4";
    if (args[0] === "diff") return "docs/release.md\n";
    if (args[0] === "log") return "docs: explain syntax\n* feat(ui): example only\x1e";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  assert.equal(assertReleaseable(fakeGit), null);
});

test("a direct tag on a non-release commit fails closed", () => {
  const fakeGit = (...args) => {
    const command = args.join(" ");
    if (command === "describe --tags --exact-match") return "v1.5.0";
    if (command === "cat-file -t refs/tags/v1.5.0") return "tag";
    if (command === "rev-parse v1.5.0^{}" || command === "rev-parse HEAD") return "abc";
    if (command === "log -1 --format=%s HEAD") return "feat: bypass the generator";
    throw new Error(`unexpected git call: ${command}`);
  };

  assert.throws(
    () => assertReleaseTag(fakeGit, releasedVersionFile, null),
    /generated release commit/,
  );
});

test("the generated v1.5.0 tag passes only with exact ancestry, files, and versions", () => {
  assert.equal(
    assertReleaseTag(
      generatedReleaseGit,
      releasedVersionFile,
      null,
      parentVersionFile,
      generatedReleaseSection,
    ),
    "1.5.0",
  );
});

test("an obsolete generated tag cannot be republished from a newer main", () => {
  const staleGit = (...args) => {
    if (
      args.join(" ") ===
      "describe --tags --match=v* --abbrev=0 refs/remotes/origin/main"
    ) {
      return "v1.6.0";
    }
    return generatedReleaseGit(...args);
  };

  assert.throws(
    () =>
      assertReleaseTag(
        staleGit,
        releasedVersionFile,
        null,
        parentVersionFile,
        generatedReleaseSection,
      ),
    /obsolete/,
  );
});

test("allowlisted release files permit only generator-owned version deltas", () => {
  const corruptions = {
    "backend/app/_version.py": (text) => `${text}print("unexpected")\n`,
    "frontend/package.json": (text) => {
      const data = JSON.parse(text);
      data.scripts.postinstall = "run-unreviewed-code";
      return JSON.stringify(data);
    },
    "frontend/package-lock.json": (text) => {
      const data = JSON.parse(text);
      data.packages["node_modules/new"] = { version: "9.9.9" };
      return JSON.stringify(data);
    },
    "frontend/src-tauri/Cargo.toml": (text) => `${text}unreviewed = "1"\n`,
    "frontend/src-tauri/Cargo.lock": (text) => `${text}\n[[package]]\nname = "unreviewed"\nversion = "1.0.0"\n`,
    "frontend/src-tauri/tauri.conf.json": (text) => {
      const data = JSON.parse(text);
      data.app.security.csp = "default-src *";
      return JSON.stringify(data);
    },
    "CHANGELOG.md": (text) => text.replace("## [1.4.4]", "## [0.0.0]"),
  };
  for (const [path, corrupt] of Object.entries(corruptions)) {
    const read = (candidate) =>
      candidate === path ? corrupt(releasedVersionFile(candidate)) : releasedVersionFile(candidate);
    assert.throws(
      () =>
        assertReleaseTag(
          generatedReleaseGit,
          read,
          null,
          parentVersionFile,
          generatedReleaseSection,
        ),
      /releaseability:/,
      path,
    );
  }
});

test("generated JSON and changelog bytes must match the canonical generator", () => {
  const jsonReformatted = (path) => {
    const data = JSON.parse(releasedVersionFile(path));
    return JSON.stringify(data, null, 4) + "\n";
  };
  const arbitraryChangelog = (text) =>
    text.replace("* feat: reviewed work", "* feat: reviewed work\n\n* FALSE CLAIM: not generated");

  assert.throws(
    () =>
      assertReleaseTag(
        generatedReleaseGit,
        (path) =>
          path === "frontend/package.json" ? jsonReformatted(path) : releasedVersionFile(path),
        null,
        parentVersionFile,
        generatedReleaseSection,
      ),
    /releaseability:/,
  );
  assert.throws(
    () =>
      assertReleaseTag(
        generatedReleaseGit,
        (path) =>
          path === "CHANGELOG.md"
            ? arbitraryChangelog(releasedVersionFile(path))
            : releasedVersionFile(path),
        null,
        parentVersionFile,
        generatedReleaseSection,
      ),
    /releaseability:/,
  );
});

test("the canonical renderer is identical before and after the generated tag exists", () => {
  const cwd = mkdtempSync(join(tmpdir(), "media-sorter-release-render-"));
  try {
    runGit(cwd, "init", "--quiet");
    runGit(cwd, "config", "user.name", "Release Test");
    runGit(cwd, "config", "user.email", "release-test@example.invalid");
    runGit(cwd, "remote", "add", "origin", "https://github.com/fileworks/media-sorter.git");
    writeFileSync(join(cwd, "package.json"), '{"name":"media-sorter-release"}\n');
    runGit(cwd, "add", "package.json");
    runGit(cwd, "commit", "--quiet", "-m", "fix: prior release");
    runGit(cwd, "tag", "-a", "v1.4.4", "-m", "v1.4.4");
    writeFileSync(join(cwd, "feature.txt"), "reviewed\n");
    runGit(cwd, "add", "feature.txt");
    runGit(cwd, "commit", "--quiet", "-m", "feat(core): reviewed work");
    const beforeArgs = [renderer, "1.5.0", "v1.4.4", "v1.5.0", "HEAD", "2026-08-22"];
    const beforeTag = execFileSync(process.execPath, beforeArgs, { cwd, encoding: "utf8" });

    writeFileSync(join(cwd, "release.txt"), "generated release\n");
    runGit(cwd, "add", "release.txt");
    runGit(cwd, "commit", "--quiet", "-m", "chore(release): v1.5.0");
    runGit(cwd, "tag", "-a", "v1.5.0", "-m", "v1.5.0");
    const afterArgs = [renderer, "1.5.0", "v1.4.4", "v1.5.0", "HEAD^", "2026-08-22"];
    const afterTag = execFileSync(process.execPath, afterArgs, { cwd, encoding: "utf8" });

    assert.match(beforeTag, /### Features/);
    assert.match(beforeTag, /reviewed work/);
    assert.equal(afterTag, beforeTag);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("generated release files cannot acquire executable or other mode changes", () => {
  const changedModeGit = (...args) =>
    args.join(" ") === "diff --summary HEAD^..HEAD"
      ? "mode change 100644 => 100755 backend/app/_version.py"
      : generatedReleaseGit(...args);

  assert.throws(
    () => assertReleaseTag(changedModeGit, releasedVersionFile, null, parentVersionFile),
    /file modes or identities/,
  );
});

test("a generated release commit with an unrelated file fails closed", () => {
  const fakeGit = (...args) => {
    const command = args.join(" ");
    if (command === "describe --tags --exact-match") return "v1.5.0";
    if (command === "cat-file -t refs/tags/v1.5.0") return "tag";
    if (command === "rev-parse v1.5.0^{}" || command === "rev-parse HEAD") return "release";
    if (command === "log -1 --format=%s HEAD") return "chore(release): v1.5.0";
    if (command === "diff --name-only HEAD^..HEAD") {
      return [...GENERATED_RELEASE_FILES, "backend/app/safety.py"].join("\n");
    }
    throw new Error(`unexpected git call: ${command}`);
  };

  assert.throws(
    () => assertReleaseTag(fakeGit, releasedVersionFile, null),
    /non-generated or missing files/,
  );
});
