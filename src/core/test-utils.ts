import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import type { ClaudeSpec } from "./spec.js";

// Re-exported, not redefined: the temp root lives in `tmp-root.ts` because the
// runtime modules that need one must not pull in `makeSpec`/`initGitRepo` and
// their dependencies. One definition, two doors.
export { makeTmpDir, cleanupTmpDir } from "./tmp-root.js";
import { makeTmpDir } from "./tmp-root.js";

/**
 * This repository's root, for a test that compiles or scans the repo itself.
 * Named, never `process.cwd()`: the core takes its root explicitly.
 */
export const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * The environment for a CLI child whose HUMAN-READABLE output a test reads:
 * this process's env with GitHub's annotation mode off.
 *
 * 🔴 Found by CI, not locally: under `GITHUB_ACTIONS` every finding is ALSO
 * emitted as a `::warning::` / `::error::` annotation carrying the same
 * message, so counting a finding's text in stdout doubles it on the runner
 * while passing on a laptop. `GITHUB_STEP_SUMMARY` is dropped with it.
 */
export function humanCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  return env;
}

/**
 * A throwaway project whose ESLint is THIS repo's installed eslint (symlinked,
 * not mocked) and whose flat config is `config`, written as `eslint.config.mjs`.
 * The rule-resolution probe runs the real ESLint against it, so a fixture built
 * here tests what a user's repo would get. Clean up with `cleanupTmpDir`.
 */
export function makeEslintProject(config: string): string {
  const dir = makeTmpDir("eslint");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }),
  );
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(
    resolve(__dirname, "..", "..", "node_modules", "eslint"),
    join(dir, "node_modules", "eslint"),
    "dir",
  );
  writeFileSync(join(dir, "eslint.config.mjs"), config);
  return dir;
}

export function makeSpec(overrides?: Partial<ClaudeSpec>): ClaudeSpec {
  return {
    _specType: "claude",
    rules: {},
    ...overrides,
  } as ClaudeSpec;
}

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function initGitRepo(dir: string): void {
  git(dir, "init");
  git(dir, "config user.email test@test.com");
  git(dir, "config user.name Test");
  git(dir, "config commit.gpgsign false");
  writeFileSync(join(dir, "README.md"), "# test");
  git(dir, "add .");
  git(dir, 'commit -m "init"');
}

export { git };
