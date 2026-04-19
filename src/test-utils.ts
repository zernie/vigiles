import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import type { ClaudeSpec } from "./spec.js";

export function makeTmpDir(suffix: string = "test"): string {
  return mkdtempSync(join(tmpdir(), `vigiles-${suffix}-`));
}

export function cleanupTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
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
