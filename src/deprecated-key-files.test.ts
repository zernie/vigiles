/**
 * The `deprecated-key-files` rule through the REAL built CLI — what `lint`
 * prints, what it counts, and what exit code a CI step sees.
 *
 * The detector is unit-tested in `core/keyfiles.test.ts`; this file holds the
 * contract an upgrade relies on: at the default severity a spec still using
 * `keyFiles` is REPORTED and the exit code does not move, a spec without it
 * says nothing, and a team that opts into "error" gets a gate.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

let dir: string;

function run(args: string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** The lint JSON report's counters for this rule. */
function counters(): { issues: number; errors: number } {
  const r = run(["lint", "--json"]);
  const json = JSON.parse(r.out) as {
    deprecatedKeyFilesIssues: number;
    deprecatedKeyFilesErrors: number;
  };
  return {
    issues: json.deprecatedKeyFilesIssues,
    errors: json.deprecatedKeyFilesErrors,
  };
}

const WITH_KEYFILES = `export default instructionFile({
  keyFiles: { "src/a.ts": "First.", "src/b.ts": "Second." },
  rules: {},
});
`;

beforeEach(() => {
  dir = makeTmpDir("deprecated-key-files");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { "claude-code": {} } }));
  put("CLAUDE.md", "# Project\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("a spec using keyFiles is reported at warn, with its size and the migration link", () => {
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  const r = run(["lint"]);
  assert.match(r.out, /Deprecated-key-files check:/);
  assert.match(
    r.out,
    /⚠ CLAUDE\.md\.spec\.ts: `keyFiles` is deprecated .*2 entries, 58 characters/,
  );
  assert.match(r.out, /docs\/rules\/deprecated-key-files\.md/);
  assert.deepEqual(counters(), { issues: 1, errors: 0 });
});

test("the default severity never changes the exit code — upgrading must not turn CI red", () => {
  // Same repo with and without the field: the field may add a warning, never an exit.
  put("CLAUDE.md.spec.ts", "export default instructionFile({ rules: {} });\n");
  const without = run(["lint"]).code;
  assert.equal(without, 0, "control: the repo is otherwise clean");
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  assert.equal(run(["lint"]).code, 0);
});

test("silent on a spec without keyFiles, and on keyFiles only in a comment", () => {
  put(
    "CLAUDE.md.spec.ts",
    `export default instructionFile({\n  // keyFiles: { "a": "b" },\n  rules: {},\n});\n`,
  );
  const r = run(["lint"]);
  assert.doesNotMatch(r.out, /Deprecated-key-files/);
  assert.deepEqual(counters(), { issues: 0, errors: 0 });
});

test("opted into error, it gates; turned off, it says nothing", () => {
  put("CLAUDE.md.spec.ts", WITH_KEYFILES);
  put(
    ".vigilesrc.json",
    JSON.stringify({
      harnesses: { "claude-code": {} },
      rules: { "deprecated-key-files": "error" },
    }),
  );
  const gated = run(["lint"]);
  assert.match(gated.out, /✗ CLAUDE\.md\.spec\.ts: `keyFiles` is deprecated/);
  assert.equal(gated.code, 2);
  assert.deepEqual(counters(), { issues: 1, errors: 1 });

  put(
    ".vigilesrc.json",
    JSON.stringify({
      harnesses: { "claude-code": {} },
      rules: { "deprecated-key-files": false },
    }),
  );
  assert.doesNotMatch(run(["lint"]).out, /Deprecated-key-files/);
  assert.deepEqual(counters(), { issues: 0, errors: 0 });
});
