#!/usr/bin/env node

import { ConventionalChangelog } from "conventional-changelog";

const [version, previousTag, currentTag, toRef, releaseDate] = process.argv.slice(2);
if (
  !/^\d+\.\d+\.\d+$/.test(version ?? "") ||
  !/^v\d+\.\d+\.\d+$/.test(previousTag ?? "") ||
  currentTag !== `v${version}` ||
  !toRef ||
  !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate ?? "")
) {
  throw new Error("render-release-changelog: expected version, tags, ref, and ISO release date");
}

const generator = new ConventionalChangelog(process.cwd());
generator.loadPreset({ name: "conventionalcommits" });
generator.options({ releaseCount: 1 });
// The exact release tag exists by the time verification runs. Hide all real
// tags from the generator's release-state heuristic and supply the reviewed
// range/context explicitly below; otherwise it treats v${version} as already
// flushed and emits an empty section.
generator.tags({ prefix: "release-verifier-no-real-tag-" });
generator.context({
  version,
  previousTag,
  currentTag,
  date: releaseDate,
});
generator.commits({ from: previousTag, to: toRef });
generator.readRepository();

let output = "";
for await (const chunk of generator.write()) {
  output += chunk;
}
process.stdout.write(output.trim());
