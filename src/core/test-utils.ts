import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import type { ClaudeSpec } from "./spec.js";

// Re-exported, not redefined: the temp root lives in `tmp-root.ts` because the
// runtime modules that need one must not pull in `makeSpec`/`initGitRepo` and
// their dependencies. One definition, two doors.
export { makeTmpDir, cleanupTmpDir } from "./tmp-root.js";

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
