/**
 * The release pipeline, rendered locally from the real `.releaserc.json`.
 *
 * 🔴 WHY THIS EXISTS. From v16.0.0 (2026-08-17) to v31.0.0 every GitHub release shipped a
 * header and nothing else — 46 of 93 published releases, a major with a removed public API
 * among them. `conventional-changelog-conventionalcommits` had been set to ^10 so that `feat!:`
 * would mean major; preset 10 renders only through `conventional-changelog-writer@9`, while
 * `@semantic-release/release-notes-generator` 14.1.1 still loads writer 8. Rendering then
 * fails with "requires conventional-changelog-writer@9 or newer", and the release went out
 * with an empty body. Nothing checked the notes, so it held for five weeks.
 *
 * So both halves of the preset's job are asserted here, against the installed toolchain:
 * the analyzer still turns `feat!:` into a major, and the notes still carry the breaking
 * change's text. A dependency bump that breaks either turns this red before it releases.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

type PluginEntry = string | [string, Record<string, unknown>];
const releaserc = JSON.parse(readFileSync(".releaserc.json", "utf8")) as {
  plugins: PluginEntry[];
};

/** The options `.releaserc.json` gives one plugin, exactly as semantic-release would pass them. */
function optionsFor(name: string): Record<string, unknown> {
  const entry = releaserc.plugins.find((p) =>
    Array.isArray(p) ? p[0] === name : p === name,
  );
  if (entry === undefined) throw new Error(`${name} is not in .releaserc.json`);
  return Array.isArray(entry) ? entry[1] : {};
}

const breaking = {
  hash: "1111111111111111111111111111111111111111",
  message:
    "feat!: drop the compiler from vigiles/linting (#280)\n\n" +
    "BREAKING CHANGE: vigiles/linting no longer exports compileClaude.",
};
/** `!` alone, no footer — the form #152 made major. The default (angular) preset ignores it. */
const bangOnly = {
  hash: "4444444444444444444444444444444444444444",
  message: "feat!: rename the lint command",
};
const feature = {
  hash: "2222222222222222222222222222222222222222",
  message: "feat(cli): add a flag (#1)",
};
const fix = {
  hash: "3333333333333333333333333333333333333333",
  message: "fix(untested): resolve include from the config root (#281)",
};

const context = {
  cwd: process.cwd(),
  options: { repositoryUrl: "https://github.com/zernie/vigiles" },
  lastRelease: { gitTag: "v30.0.2", version: "30.0.2" },
  nextRelease: { gitTag: "v31.0.0", version: "31.0.0", type: "major" },
  logger: { log() {}, error() {} },
};

describe("release config (.releaserc.json) with the installed toolchain", () => {
  test("`feat!:` is a major (with or without a footer), `feat:` a minor, `fix:` a patch", async () => {
    const analyzer = optionsFor("@semantic-release/commit-analyzer");
    expect(
      await analyzeCommits(analyzer, { ...context, commits: [breaking] }),
    ).toBe("major");
    expect(
      await analyzeCommits(analyzer, { ...context, commits: [bangOnly] }),
    ).toBe("major");
    expect(
      await analyzeCommits(analyzer, { ...context, commits: [feature] }),
    ).toBe("minor");
    expect(await analyzeCommits(analyzer, { ...context, commits: [fix] })).toBe(
      "patch",
    );
  });

  test("the notes carry the breaking change, the feature and the fix — not just a header", async () => {
    const notes: string = await generateNotes(
      optionsFor("@semantic-release/release-notes-generator"),
      { ...context, commits: [breaking, feature, fix] },
    );
    expect(notes).toContain("BREAKING CHANGES");
    expect(notes).toContain("vigiles/linting no longer exports compileClaude.");
    expect(notes).toContain("add a flag");
    expect(notes).toContain("resolve include from the config root");
  });
});
