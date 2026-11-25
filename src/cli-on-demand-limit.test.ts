/**
 * The `on-demand-file` limit of the context-creep rule, through the REAL built
 * CLI: a repository whose sessions run on a smaller window lowers the per-file
 * cut below the harness's default, and `lint` then fails on a folder file over
 * the lowered number. The default itself and the cut's other contracts are in
 * `adapters/claude-code/on-demand-lint.test.ts`; this file holds the option,
 * because only the root may name a rule (it reads the id off the rule set).
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { checkAlwaysLoadedLimits } from "./core/always-loaded-limits.js";
import { cleanupTmpDir, humanCliEnv, makeTmpDir } from "./core/test-utils.js";
import { RULES } from "./rules/index.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

/** The rule this option belongs to, found by its detector, as the CLI finds it. */
const RULE = RULES.find((r) => r.detector === checkAlwaysLoadedLimits.name)?.id;

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

function config(limit: number | undefined): string {
  const rules =
    RULE === undefined || limit === undefined
      ? {}
      : { [RULE]: ["error", { limits: { "on-demand-file": limit } }] };
  return JSON.stringify({ rules });
}

beforeEach(() => {
  dir = makeTmpDir("on-demand-limit-option");
  put("CLAUDE.md", "# Project\n\nUse the npm scripts in package.json.\n");
  put("pkg/a.ts", "export {};\n");
  put("pkg/CLAUDE.md", `# Folder rules\n\n${"x".repeat(200)}\n`);
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("the rule is found in the set", () => {
  // Guards: the cases below configure a real rule, not an undefined key.
  expect(RULE).toBeDefined();
});

test("a lowered limit fails a folder file the default passes", () => {
  put(".vigilesrc.json", config(undefined));
  // Guards: the control — a 200-character folder file is under the default cut.
  expect(run(["lint"]).code).toBe(0);
  put(".vigilesrc.json", config(100));
  const r = run(["lint"]);
  // Guards: the threshold is the repository's to set, below the default too.
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("pkg/CLAUDE.md");
});
