/**
 * The `context-truncation` rule's CONFIG, through the REAL built CLI: its
 * `limit` option (a repository on a smaller window lowers the per-file cut)
 * and its independence from `context-creep` (each rule has its own switch).
 * The cut's other contracts are in `adapters/claude-code/on-demand-lint.test.ts`;
 * this file lives at the root because only the root may name a rule — it reads
 * both ids off the rule set by their detectors, as the CLI does.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { checkAlwaysLoadedLimits } from "./core/always-loaded-limits.js";
import { checkOnDemandFiles } from "./core/on-demand-limits.js";
import { cleanupTmpDir, humanCliEnv, makeTmpDir } from "./core/test-utils.js";
import { RULES } from "./rules/index.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

const idOf = (detector: string): string =>
  RULES.find((r) => r.detector === detector)?.id ?? "";
const TRUNCATION = idOf(checkOnDemandFiles.name);
const CREEP = idOf(checkAlwaysLoadedLimits.name);

let dir: string;

function run(args: readonly string[]): { code: number; out: string } {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: humanCliEnv(process.env),
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const config = (rules: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ rules });

beforeEach(() => {
  dir = makeTmpDir("on-demand-limit-config");
  put("CLAUDE.md", "# Project\n\nUse the npm scripts in package.json.\n");
  put("pkg/a.ts", "export {};\n");
  put("pkg/CLAUDE.md", `# Folder rules\n\n${"x".repeat(200)}\n`);
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("both rules are in the set, under different ids", () => {
  // Guards: the cases below configure two real rules, not one key twice.
  expect(TRUNCATION).not.toBe("");
  expect(CREEP).not.toBe("");
  expect(TRUNCATION).not.toBe(CREEP);
});

test("a lowered limit fails a folder file the default passes", () => {
  put(".vigilesrc.json", config({}));
  // Guards: the control — a 200-character folder file is under the default cut.
  expect(run(["lint"]).code).toBe(0);
  put(".vigilesrc.json", config({ [TRUNCATION]: ["error", { limit: 100 }] }));
  const r = run(["lint"]);
  // Guards: the threshold is the repository's to set, below the default too.
  expect(r.code).not.toBe(0);
  // Guards: each finding names its rule, so the reader knows what to configure.
  expect(r.out).toContain(`✗ [${TRUNCATION}] pkg/CLAUDE.md is`);
});

test("the weight rule off leaves the per-file cut on", () => {
  put(
    ".vigilesrc.json",
    config({ [CREEP]: "off", [TRUNCATION]: ["error", { limit: 100 }] }),
  );
  // Guards: the two checks have separate switches; one off is not both off.
  expect(run(["lint"]).code).not.toBe(0);
});

test("the per-file cut off silences it", () => {
  put(".vigilesrc.json", config({ [TRUNCATION]: "off" }));
  put("pkg/CLAUDE.md", `# Folder rules\n\n${"x".repeat(200_000)}\n`);
  const r = run(["lint"]);
  // Guards: turning the rule off is honoured even far over the cut.
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("pkg/CLAUDE.md is");
});

test("an override turns the rule off for one folder only", () => {
  put("other/CLAUDE.md", `# Other\n\n${"x".repeat(200)}\n`);
  put(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { [TRUNCATION]: ["error", { limit: 100 }] },
      overrides: [{ files: ["pkg/**"], rules: { [TRUNCATION]: "off" } }],
    }),
  );
  const r = run(["lint"]);
  // Guards: severity is read per finding's path, so `overrides` reach this rule.
  expect(r.out).not.toContain("pkg/CLAUDE.md is");
  expect(r.out).toContain("other/CLAUDE.md is");
  expect(r.code).not.toBe(0);
});

test("an override at warn reports the folder without failing", () => {
  put(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { [TRUNCATION]: ["error", { limit: 100 }] },
      overrides: [{ files: ["pkg/**"], rules: { [TRUNCATION]: "warn" } }],
    }),
  );
  const r = run(["lint"]);
  // Guards: a per-folder warn is a warning, not the rule-wide error.
  expect(r.out).toContain(`⚠ [${TRUNCATION}] pkg/CLAUDE.md is`);
  expect(r.code).toBe(0);
});
