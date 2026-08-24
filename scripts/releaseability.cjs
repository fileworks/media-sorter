const { execFileSync } = require("node:child_process");

const { readFileSync } = require("node:fs");
const { EOL } = require("node:os");

const RELEASE_HEADER =
  "# Changelog\n\nAll notable changes to MediaSorter are documented here.\n" +
  "This file is generated from [Conventional Commits](https://www.conventionalcommits.org/) " +
  "by release-it; do not edit it by hand.";

const CONVENTIONAL = /^(feat|feature|fix|perf|revert)(?:\([^\r\n)]*\))?(!)?:\s+\S/i;
const BREAKING = /^BREAKING(?: CHANGE|-CHANGE):\s+\S/i;
const GENERATED_RELEASE_FILES = new Set([
  "CHANGELOG.md",
  "backend/app/_version.py",
  "frontend/package.json",
  "frontend/package-lock.json",
  "frontend/src-tauri/Cargo.toml",
  "frontend/src-tauri/Cargo.lock",
  "frontend/src-tauri/tauri.conf.json",
]);

function releaseRecordLines(text) {
  const records = [];
  let fence = null;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence === null && marker !== null) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    if (fence !== null) {
      const closing = raw.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        closing !== null &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (/^(?: {4}|\t)/.test(raw) || trimmed.startsWith(">")) continue;
    records.push(trimmed.replace(/^[-*]\s+/, ""));
  }
  return records;
}

function conventionalRecords(text) {
  return releaseRecordLines(text)
    .map((line) => ({ line, match: line.match(CONVENTIONAL) }))
    .filter((item) => item.match !== null);
}

function bumpLevel(texts) {
  let level = null;
  for (const text of texts) {
    if (releaseRecordLines(text).some((line) => BREAKING.test(line))) {
      level = 0;
      continue;
    }
    for (const { match } of conventionalRecords(text)) {
      const type = match[1].toLowerCase();
      const next = match[2] ? 0 : type === "feat" || type === "feature" ? 1 : 2;
      level = level === null ? next : Math.min(level, next);
    }
  }
  return level;
}

/**
 * Conventional commits are sometimes aggregated into a reviewed Wave commit.
 * Their body still contains the individual `feat:`/`fix:` records, but the
 * default parser only examines the aggregate subject and returns no release.
 */
function whatBump(commits) {
  const texts = commits.map((commit) => `${commit.header ?? ""}\n${commit.body ?? ""}`);
  const level = bumpLevel(texts);
  return level === null ? null : { level, reason: "Reviewed conventional commit records" };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parentFile(path) {
  return execFileSync("git", ["show", `HEAD^:${path}`], { encoding: "utf8" });
}

function headFile(path) {
  return execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
}

function renderReleaseSection(version, previousTag, currentTag, releaseDate) {
  return execFileSync(
    process.execPath,
    [
      "scripts/render-release-changelog.mjs",
      version,
      previousTag,
      currentTag,
      "HEAD^",
      releaseDate,
    ],
    { encoding: "utf8" },
  ).trim();
}

function assertReleaseable(gitCommand = git, head = "HEAD") {
  const latestTag = gitCommand("describe", "--tags", "--match=v*", "--abbrev=0", head);
  const files = gitCommand("diff", "--name-only", `${latestTag}..${head}`)
    .split("\n")
    .filter(Boolean);
  const material = files.filter(
    (file) =>
      !file.startsWith("docs/") &&
      !file.startsWith("openspec/") &&
      !file.startsWith(".github/") &&
      !file.endsWith(".md") &&
      !file.includes("/tests/") &&
      !file.startsWith("tests/"),
  );
  const commits = gitCommand("log", "--format=%s%n%b%x1e", `${latestTag}..${head}`)
    .split("\x1e")
    .filter(Boolean);
  const level = bumpLevel(commits);
  if (material.length > 0 && level === null) {
    throw new Error(
      `releaseability: material changes after ${latestTag} have no conventional next version; ` +
        "add a reviewed feat/fix/perf record or stop the release",
    );
  }
  return material.length === 0 ? null : level;
}

function versions(read = (path) => readFileSync(path, "utf8")) {
  const jsonVersion = (path) => JSON.parse(read(path)).version;
  const matchVersion = (path, pattern) => {
    const match = read(path).match(pattern);
    if (!match) throw new Error(`releaseability: cannot read version from ${path}`);
    return match[1];
  };
  return {
    backend: matchVersion("backend/app/_version.py", /__version__ = "([^"]+)"/),
    frontend: jsonVersion("frontend/package.json"),
    frontendLock: jsonVersion("frontend/package-lock.json"),
    tauri: jsonVersion("frontend/src-tauri/tauri.conf.json"),
    cargo: matchVersion(
      "frontend/src-tauri/Cargo.toml",
      /\[package\][\s\S]*?\nversion = "([^"]+)"/,
    ),
    cargoLock: matchVersion(
      "frontend/src-tauri/Cargo.lock",
      /name = "media-sorter"\nversion = "([^"]+)"/,
    ),
  };
}

function stableVersion(tag) {
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error(`releaseability: expected an exact stable tag, got ${tag}`);
  return version;
}

/** Refuse to release a tree whose embedded source identity was pre-bumped or drifted. */
function assertSourceAtLatestTag(
  gitCommand = git,
  read = (path) => readFileSync(path, "utf8"),
) {
  const latestTag = gitCommand("describe", "--tags", "--match=v*", "--abbrev=0", "HEAD");
  const expected = stableVersion(latestTag);
  const observed = versions(read);
  if (Object.values(observed).some((version) => version !== expected)) {
    throw new Error(
      `releaseability: source versions must all equal ${latestTag} before generation; ` +
        `observed ${JSON.stringify(observed)}`,
    );
  }
  return expected;
}

function assertGeneratedReleaseContents(version, read, readParent, generatedSection) {
  const exactTransforms = new Map([
    [
      "backend/app/_version.py",
      (content) => content.replace(/__version__ = "[^"]+"/, `__version__ = "${version}"`),
    ],
    [
      "frontend/src-tauri/Cargo.toml",
      (content) =>
        content.replace(
          /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/,
          `$1${version}$2`,
        ),
    ],
    [
      "frontend/src-tauri/Cargo.lock",
      (content) =>
        content.replace(
          /(\[\[package\]\]\nname = "media-sorter"\nversion = ")[^"]+("\n)/,
          `$1${version}$2`,
        ),
    ],
  ]);
  for (const [path, transform] of exactTransforms) {
    const parent = readParent(path);
    const expected = transform(parent);
    if (expected === parent || read(path) !== expected) {
      throw new Error(`releaseability: release commit changed more than the version in ${path}`);
    }
  }

  for (const path of [
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/src-tauri/tauri.conf.json",
  ]) {
    const expected = JSON.parse(readParent(path));
    expected.version = version;
    if (path.endsWith("package-lock.json")) {
      if (!expected.packages || !expected.packages[""]) {
        throw new Error("releaseability: package lock has no root package version");
      }
      expected.packages[""].version = version;
    }
    const expectedBytes = JSON.stringify(expected, null, 2) + "\n";
    if (read(path) !== expectedBytes) {
      throw new Error(`releaseability: ${path} does not match canonical generated bytes`);
    }
  }

  const parentChangelog = readParent("CHANGELOG.md");
  const currentChangelog = read("CHANGELOG.md");
  const header = RELEASE_HEADER.split(/\r\n|\r|\n/g).join(EOL);
  const previousBody = parentChangelog.trim().replace(header, "").trim();
  const expectedChangelog =
    header +
    (generatedSection ? EOL + EOL + generatedSection.trim() : "") +
    (previousBody ? EOL + EOL + previousBody : "") +
    EOL;
  if (currentChangelog !== expectedChangelog) {
    throw new Error("releaseability: CHANGELOG.md does not match canonical generated bytes");
  }
}

function increment(version, level) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`releaseability: unsupported previous version ${version}`);
  let [, major, minor, patch] = match.map(Number);
  if (level === 0) return `${major + 1}.0.0`;
  if (level === 1) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Validate generated bytes while they are staged but before commit, tag, or push. */
function assertPreparedRelease(
  version,
  gitCommand = git,
  read = (path) => readFileSync(path, "utf8"),
  readBase = headFile,
  renderSection = renderReleaseSection,
  releaseDate = new Date().toISOString().slice(0, 10),
) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`releaseability: invalid prepared version ${version}`);
  }
  const previousTag = gitCommand("describe", "--tags", "--match=v*", "--abbrev=0", "HEAD");
  const previousVersion = stableVersion(previousTag);
  const bump = assertReleaseable(gitCommand);
  if (bump === null || increment(previousVersion, bump) !== version) {
    throw new Error("releaseability: prepared version does not match the calculated next version");
  }
  const observed = versions(read);
  if (Object.values(observed).some((value) => value !== version)) {
    throw new Error(
      `releaseability: prepared source disagrees with v${version}: ${JSON.stringify(observed)}`,
    );
  }
  const changed = new Set(gitCommand("diff", "--name-only", "HEAD").split("\n").filter(Boolean));
  if (
    changed.size !== GENERATED_RELEASE_FILES.size ||
    [...changed].some((file) => !GENERATED_RELEASE_FILES.has(file))
  ) {
    throw new Error("releaseability: prepared release has non-generated or missing files");
  }
  if (gitCommand("diff", "--summary", "HEAD")) {
    throw new Error("releaseability: prepared release changed generated file modes or identities");
  }
  assertGeneratedReleaseContents(
    version,
    read,
    readBase,
    renderSection(version, previousTag, `v${version}`, "HEAD", releaseDate),
  );
  return version;
}

function assertReleaseTag(
  gitCommand = git,
  read = (path) => readFileSync(path, "utf8"),
  refName = process.env.GITHUB_REF_NAME,
  readParent = parentFile,
  renderSection = renderReleaseSection,
) {
  const tag = refName || gitCommand("describe", "--tags", "--exact-match");
  const version = stableVersion(tag);
  if (gitCommand("cat-file", "-t", `refs/tags/${tag}`) !== "tag") {
    throw new Error("releaseability: release tags must be annotated generator-owned tags");
  }
  if (gitCommand("rev-parse", `${tag}^{}`) !== gitCommand("rev-parse", "HEAD")) {
    throw new Error("releaseability: checked-out source does not match the release tag");
  }
  if (gitCommand("log", "-1", "--format=%s", "HEAD") !== `chore(release): ${tag}`) {
    throw new Error("releaseability: tag does not point at a generated release commit");
  }
  const changed = new Set(
    gitCommand("diff", "--name-only", "HEAD^..HEAD").split("\n").filter(Boolean),
  );
  if (
    changed.size !== GENERATED_RELEASE_FILES.size ||
    [...changed].some((file) => !GENERATED_RELEASE_FILES.has(file))
  ) {
    throw new Error("releaseability: release commit contains non-generated or missing files");
  }
  if (gitCommand("diff", "--summary", "HEAD^..HEAD")) {
    throw new Error("releaseability: release commit changed generated file modes or identities");
  }
  const observedVersions = versions(read);
  if (Object.values(observedVersions).some((observed) => observed !== version)) {
    throw new Error(
      `releaseability: ${tag} disagrees with embedded versions ${JSON.stringify(observedVersions)}`,
    );
  }
  const bump = assertReleaseable(gitCommand, "HEAD^");
  if (bump === null) {
    throw new Error("releaseability: release candidate has no material next version");
  }
  const previous = gitCommand("describe", "--tags", "--match=v*", "--abbrev=0", "HEAD^");
  const previousVersion = previous.replace(/^v/, "");
  const parentVersions = versions(readParent);
  if (Object.values(parentVersions).some((observed) => observed !== previousVersion)) {
    throw new Error("releaseability: release parent disagrees with the previous tag version");
  }
  const releaseDate = gitCommand("show", "-s", "--format=%cs", "HEAD");
  const escaped = version.replaceAll(".", "\\.");
  const headingDate = read("CHANGELOG.md").match(
    new RegExp(`^## \\[${escaped}\\].* \\((\\d{4}-\\d{2}-\\d{2})\\)$`, "m"),
  )?.[1];
  if (headingDate !== releaseDate) {
    throw new Error("releaseability: generated changelog date disagrees with the release commit");
  }
  assertGeneratedReleaseContents(
    version,
    read,
    readParent,
    renderSection(version, previous, tag, releaseDate),
  );
  if (increment(previousVersion, bump) !== version) {
    throw new Error("releaseability: tag version does not match the calculated next version");
  }
  gitCommand("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main");
  const latestMainTag = gitCommand(
    "describe",
    "--tags",
    "--match=v*",
    "--abbrev=0",
    "refs/remotes/origin/main",
  );
  if (latestMainTag !== tag) {
    throw new Error(
      `releaseability: ${tag} is obsolete; the latest release transaction on origin/main is ${latestMainTag}`,
    );
  }
  return version;
}

if (require.main === module) {
  if (process.argv.includes("--verify-tag")) {
    console.log(`releaseability: verified release v${assertReleaseTag()}`);
  } else if (process.argv.includes("--verify-bump")) {
    const index = process.argv.indexOf("--verify-bump");
    console.log(`releaseability: verified prepared v${assertPreparedRelease(process.argv[index + 1])}`);
  } else {
    assertSourceAtLatestTag();
    const level = assertReleaseable();
    console.log(
      level === null ? "releaseability: no release required" : `releaseability: bump level ${level}`,
    );
  }
}

module.exports = {
  RELEASE_HEADER,
  assertPreparedRelease,
  assertReleaseable,
  assertReleaseTag,
  assertSourceAtLatestTag,
  bumpLevel,
  versions,
  whatBump,
};
