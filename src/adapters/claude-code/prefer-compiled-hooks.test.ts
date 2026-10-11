/**
 * `prefer-compiled-hooks`: one finding PER hand-written hook (#361).
 *
 * A static reader cannot tell what a hand-written shell line runs or whether it
 * swallows its own failure, so vigiles no longer guesses which word is the
 * script. It says so, once per hook, and points at compiled hooks — whose
 * command line vigiles writes itself and can therefore check exactly.
 *
 * What stays checked: the trivially safe case, a line that STARTS by running a
 * literal path (`hook-script-exists`), and the files a compiled line runs.
 *
 * Claude-Code-shaped fixtures (`.claude/settings.json`, `${CLAUDE_PROJECT_DIR}`),
 * so this lives in the adapter. The Codex half is in `../codex/codex.test.ts`;
 * the classifier itself is harness-neutral (`core/hook-command.test.ts`).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { hookCommandShape } from "../../core/hook-command.js";
import { withRoleExit } from "../../core/hook-program.js";
import { hookGateRef, hookRuntimeRef } from "../../hook-install.js";
import { scanPlugin } from "../../scan.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

const CLI = resolve(process.cwd(), "dist", "cli.js");

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** `.claude/settings.json` with each command as its own `PostToolUse` hook. */
function settings(...commands: string[]): string {
  return JSON.stringify({
    hooks: {
      PostToolUse: commands.map((command) => ({
        matcher: "Edit|Write",
        hooks: [{ type: "command", command }],
      })),
    },
  });
}

function lint(dir: string): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, "lint"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout };
}

/** The lines `lint` prints for this rule. */
const findings = (stdout: string): string[] =>
  stdout.split("\n").filter((l) => /cannot verify|cannot tell/.test(l));

const COMPILED = withRoleExit(
  `${hookRuntimeRef(claudeCodeLayout.projectRootTokens)} hook-runtime run-program ` +
    hookGateRef(".vigiles/hooks/x.hook.mjs", claudeCodeLayout.projectRootTokens),
  "react",
);

test("the line `compile` emits is recognised as compiled, by the same helpers that emit it", () => {
  // Binds the reader to the writer: if the emitted template changes, this
  // goes red here instead of every compiled hook turning into a finding.
  const tokens = [
    claudeCodeLayout.pluginRootToken,
    ...(claudeCodeLayout.projectRootTokens ?? []),
  ];
  assert.deepEqual(hookCommandShape(COMPILED, tokens), {
    kind: "compiled",
    files: [
      "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js",
      "${CLAUDE_PROJECT_DIR}/.vigiles/hooks/x.hook.mjs",
    ],
  });
});

test("a hand-written `sh -c` hook gets ONE warning that names it, and no guessed script", () => {
  const dir = makeTmpDir("pch-sh-c");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    write(dir, ".claude/settings.json", settings("sh -c 'node hooks/gone.mjs'"));
    const scan = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.deepEqual(scan.hooks, [], "no word is guessed to be the script");
    assert.deepEqual(scan.handWrittenHooks, [
      {
        event: "PostToolUse",
        command: "sh -c 'node hooks/gone.mjs'",
        kind: "opaque",
      },
    ]);
    const r = lint(dir);
    assert.equal(r.status, 0, r.stdout);
    const lines = findings(r.stdout);
    assert.equal(lines.length, 1, r.stdout);
    assert.match(lines[0] ?? "", /PostToolUse hook `sh -c 'node hooks\/gone\.mjs'`/);
    assert.match(r.stdout, /vigiles\/hook/);
    assert.match(r.stdout, /docs\/compiled-hooks\.md/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a hand-written hook that starts with a literal path to a missing file is `hook-script-exists`", () => {
  const dir = makeTmpDir("pch-literal-missing");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    write(
      dir,
      ".claude/settings.json",
      settings('"$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.sh'),
    );
    const scan = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.deepEqual(
      scan.hooks.map((h) => [h.script, h.status]),
      [[join(dir, ".claude/hooks/gone.sh"), "missing"]],
    );
    const r = lint(dir);
    assert.match(r.stdout, /Hook-script existence check:/);
    assert.match(r.stdout, /\.claude\/hooks\/gone\.sh" is referenced but missing/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a compiled hook is not reported as unverifiable", () => {
  const dir = makeTmpDir("pch-compiled");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    write(dir, ".claude/settings.json", settings(COMPILED));
    write(dir, ".vigiles/hooks/x.hook.mjs", "export default {};\n");
    write(dir, "node_modules/vigiles/dist/cli.js", "// cli\n");
    const scan = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.deepEqual(scan.handWrittenHooks, []);
    assert.deepEqual(findings(lint(dir).stdout), []);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("three hand-written hooks are three findings; `false` in the config still turns the rule off", () => {
  const dir = makeTmpDir("pch-three");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    write(dir, ".claude/hooks/ok.sh", "#!/bin/sh\n");
    write(
      dir,
      ".claude/settings.json",
      settings(
        "npx prettier --check .",
        'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/ok.sh" || true',
        '[ -f x ] && echo "$x"',
      ),
    );
    const lines = findings(lint(dir).stdout);
    assert.equal(lines.length, 3, lines.join("\n"));
    // The one whose script vigiles did check says so, rather than claiming
    // it might point at a missing file.
    assert.equal(lines.filter((l) => /checks that its script exists/.test(l)).length, 1);

    write(
      dir,
      ".vigilesrc.json",
      JSON.stringify({ rules: { "prefer-compiled-hooks": false } }),
    );
    assert.deepEqual(findings(lint(dir).stdout), []);
  } finally {
    cleanupTmpDir(dir);
  }
});
