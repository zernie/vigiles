/**
 * Hook scripts written with Claude Code's project-root variable
 * (`$CLAUDE_PROJECT_DIR`, both spellings) resolve against the scanned root, so
 * `audit` and `hook-script-exists` check them.
 *
 * Claude-Code-shaped fixture (`.claude/settings.json`), so it lives in the
 * adapter. The runner half (`node_modules/vigiles/dist/cli.js`) is in
 * ./hook-runner-exists.test.ts.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { scanPlugin } from "../../scan.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

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
  try {
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
    // A variable the harness does NOT set is not resolved into a guess: the
    // line is opaque — no file is taken for its script, and it is named (#361).
    assert.equal(byBase(".claude/hooks/x.sh"), undefined);
    assert.deepEqual(
      r.handWrittenHooks
        .filter((h) => h.kind === "opaque")
        .map((h) => h.command),
      ['"$SOME_OTHER_VAR"/.claude/hooks/x.sh'],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
