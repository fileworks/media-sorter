const { RELEASE_HEADER, assertReleaseable } = require("./scripts/releaseability.cjs");

module.exports = {
  git: {
    requireBranch: "main",
    requireCleanWorkingDir: true,
    requireUpstream: true,
    requireCommits: true,
    commitMessage: "chore(release): v${version}",
    tagName: "v${version}",
    tagAnnotation: "v${version}",
    push: true,
    pushArgs: ["--atomic", "--follow-tags"],
  },
  github: { release: false },
  npm: false,
  hooks: {
    "before:init": "node scripts/releaseability.cjs",
    "after:bump": "node scripts/sync-version.mjs ${version}",
    "before:git:release": "node scripts/releaseability.cjs --verify-bump ${version}",
  },
  plugins: {
    "@release-it/conventional-changelog": {
      preset: { name: "conventionalcommits" },
      infile: "CHANGELOG.md",
      header: RELEASE_HEADER,
      whatBump() {
        const level = assertReleaseable();
        return level === null
          ? null
          : { level, reason: "Material reviewed conventional commit records" };
      },
    },
  },
};
