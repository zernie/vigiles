/**
 * `$CLAUDE_PROJECT_DIR` hook scripts in the audit's hook scan. Lives beside the
 * adapter because the variable and the `.claude/` paths are its vocabulary.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scanPlugin } from "../../scan.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeDialect } from "./dialect.js";

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

test("scanPlugin resolves $CLAUDE_PROJECT_DIR hook scripts against the project root", () => {
  // The documented spelling for a project hook (hooks do not run with a stable
  // cwd). It used to be reported `unresolved` ("can't check") for a script that
  // sits exactly where the harness would look, so `audit` skipped every project
  // hook written the documented way.
  const dir = makeTmpDir("scan-project-dir-hooks");
  write(dir, ".claude/hooks/present.sh", "#!/bin/sh\n");
  write(
    dir,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/present.sh',
              },
              {
                type: "command",
                command: "sh ${CLAUDE_PROJECT_DIR}/.claude/hooks/absent.sh",
              },
              {
                type: "command",
                command: '"$SOME_OTHER_VAR"/.claude/hooks/x.sh',
              },
            ],
          },
        ],
      },
    }),
  );
  const r = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
  const byBase = (suffix: string) =>
    r.hooks.find((h) => h.script.endsWith(suffix));
  assert.equal(byBase(".claude/hooks/present.sh")?.status, "ok");
  assert.equal(byBase(".claude/hooks/absent.sh")?.status, "missing");
  // A variable the harness does NOT set stays uncheckable — resolving only the
  // documented project token must not turn every `$VAR` into a guess.
  assert.equal(byBase(".claude/hooks/x.sh")?.status, "unresolved");
  cleanupTmpDir(dir);
});
