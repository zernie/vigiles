/**
 * The `deprecated-key-files` rule through the REAL built CLI — `lint` and
 * `audit` (text and `--json`). Both read one detector
 * (`findDeprecatedKeyFiles`), so the two halves below cannot disagree.
 *
 * The parser and the message are unit-tested in `core/keyfiles.test.ts`; this
 * file holds the contract an upgrade relies on: at the default severity a spec
 * still using `keyFiles` is REPORTED and the exit code does not move, a spec
 * without it says nothing, and a team that opts into "error" gets a gate.
 */
import { test, beforeEach, afterEach, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

let dir: string;

function run(args: readonly string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf-8",
    env,
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** `lint --json`, where this rule's counters live. */
function counters(): unknown {
  return JSON.parse(run(["lint", "--json"]).out);
}

const WITH_KEYFILES = `export default instructionFile({
  keyFiles: { "src/a.ts": "First.", "src/b.ts": "Second." },
  rules: {},
});
`;

beforeEach(() => {
  dir = makeTmpDir("deprecated-key-files");
  put(".vigilesrc.json", "{}");
  put("CLAUDE.md", "# Project\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("lint: a spec using keyFiles is reported at warn, with its size and the migration link", () => {
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  const r = run(["lint"]);
  expect(r.out).toContain("Deprecated-key-files check:");
  expect(r.out).toMatch(
    /⚠ CLAUDE\.md\.spec\.ts: `keyFiles` is deprecated .*2 entries, 58 characters/,
  );
  expect(r.out).toContain("docs/rules/deprecated-key-files.md");
  // The warning says where each entry goes, not only that the field is deprecated.
  expect(r.out).toMatch(
    /For each entry: delete it .* header comment .*<folder>\/CLAUDE\.md .*one-line file\(\) pointer/,
  );
  expect(counters()).toMatchObject({
    deprecatedKeyFilesIssues: 1,
    deprecatedKeyFilesErrors: 0,
  });
});

test("lint: the default severity never changes the exit code — upgrading must not turn CI red", () => {
  put("CLAUDE.md.spec.ts", "export default instructionFile({ rules: {} });\n");
  expect(run(["lint"]).code, "control: the repo is otherwise clean").toBe(0);
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  expect(run(["lint"]).code).toBe(0);
});

test("lint: silent on a spec without keyFiles, and on keyFiles only in a comment", () => {
  put(
    "CLAUDE.md.spec.ts",
    `export default instructionFile({\n  // keyFiles: { "a": "b" },\n  rules: {},\n});\n`,
  );
  expect(run(["lint"]).out).not.toContain("Deprecated-key-files");
  expect(counters()).toMatchObject({
    deprecatedKeyFilesIssues: 0,
    deprecatedKeyFilesErrors: 0,
  });
});

test("lint: opted into error, it gates; turned off, it says nothing", () => {
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  put(
    ".vigilesrc.json",
    JSON.stringify({ rules: { "deprecated-key-files": "error" } }),
  );
  const gated = run(["lint"]);
  expect(gated.out).toMatch(/✗ CLAUDE\.md\.spec\.ts: `keyFiles` is deprecated/);
  expect(gated.code).toBe(2);
  expect(counters()).toMatchObject({
    deprecatedKeyFilesIssues: 1,
    deprecatedKeyFilesErrors: 1,
  });

  put(
    ".vigilesrc.json",
    JSON.stringify({ rules: { "deprecated-key-files": false } }),
  );
  expect(run(["lint"]).out).not.toContain("Deprecated-key-files");
  expect(counters()).toMatchObject({ deprecatedKeyFilesIssues: 0 });
});

test("audit: every spec still using keyFiles, with its size and the fix — never node_modules or an excluded dir", () => {
  put(".vigilesrc.json", JSON.stringify({ exclude: ["vendor"] }));
  put(
    "CLAUDE.md.spec.ts",
    `export default instructionFile({ keyFiles: { "a.ts": "First.", "b.ts": "Second." }, rules: {} });\n`,
  );
  // A nested spec is still a spec using the field.
  put(
    "pkg/AGENTS.md.spec.ts",
    `export default instructionFile({ keyFiles: files, rules: {} });\n`,
  );
  const stray = `export default instructionFile({ keyFiles: { "x": "y" }, rules: {} });\n`;
  put("node_modules/dep/CLAUDE.md.spec.ts", stray);
  put("vendor/CLAUDE.md.spec.ts", stray);

  const text = run(["audit"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("Deprecated `keyFiles` (2):");
  expect(text.out).toContain(
    "⚠ CLAUDE.md.spec.ts: 2 entries, 50 characters compiled into the instruction file",
  );
  expect(text.out).toContain(
    "⚠ pkg/AGENTS.md.spec.ts: not a literal map — size not measured",
  );
  // The fix once, with the four places an entry can go; the nested file is
  // named after each reported spec's own instruction file.
  expect(text.out).toMatch(
    /→ For each entry: delete it .*header comment.*<folder>\/CLAUDE\.md or <folder>\/AGENTS\.md.*one-line file\(\) pointer[^\n]*\n\s+\S+deprecated-key-files\.md {2}\[deprecated-key-files\]/,
  );
  // Advisory: a deprecation is not a structural defect.
  expect(text.out).not.toMatch(/structural issue\(s\)/);

  // …and the same findings reach the JSON report, not only the terminal.
  const json: unknown = JSON.parse(run(["audit", "--json"]).out);
  expect(json).toMatchObject({
    deprecatedKeyFiles: [
      { path: "CLAUDE.md.spec.ts", entries: 2, chars: 50, measured: true },
      { path: "pkg/AGENTS.md.spec.ts", entries: 0, chars: 0, measured: false },
    ],
  });
});

test("audit: a spec without keyFiles leaves the report unchanged", () => {
  put("CLAUDE.md.spec.ts", "export default instructionFile({ rules: {} });\n");
  expect(run(["audit"]).out).not.toContain("keyFiles");
  const json: unknown = JSON.parse(run(["audit", "--json"]).out);
  expect(json).not.toHaveProperty("deprecatedKeyFiles");
});
