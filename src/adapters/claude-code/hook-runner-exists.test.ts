/**
 * `hook-script-exists` for the case that hid a dead hook in the vigiles
 * repository itself for three weeks (measured 2026-10-11): a compiled hook whose
 * RUNTIME does not exist.
 *
 *   node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime \
 *     run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/x.hook.mjs" || exit 0
 *
 * The `|| exit 0` is deliberate (a reminder fails open), so the shell turns the
 * MODULE_NOT_FOUND into "nothing to say". Only a path check can tell the two
 * apart, and it had two blind spots, both covered here through BOTH scan twins —
 * `scanPlugin` (disk) and `scanFiles` (file map) — and once through the real
 * `lint` binary:
 *
 * 1. The runner under `node_modules/` is a real file the hook needs. On disk it
 *    is checkable; in the file map (a GitHub fetch never includes node_modules)
 *    it is NOT, so there it must read `unresolved`, never `missing`.
 * 2. A repo that is a plugin (hooks in its manifest) AND has project settings:
 *    the loader reads only the manifest's hooks, so the project's own wiring was
 *    never path-checked at all. The vigiles repository is exactly this shape.
 *
 * Claude-Code-shaped fixtures (plugin manifest + `.claude/settings.json`), so
 * this lives in the adapter. The Codex half — relative runner, TOML hooks — is
 * in `../codex/codex.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { scanPlugin } from "../../scan.js";
import { scanFiles } from "../../scan-files.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

const CLI = resolve(process.cwd(), "dist", "cli.js");
const RUNNER = "node_modules/vigiles/dist/cli.js";
const WIRED = `node "$CLAUDE_PROJECT_DIR/${RUNNER}" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/x.hook.mjs" || exit 0`;

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function settingsWith(command: string): string {
  return JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: "Edit|Write", hooks: [{ type: "command", command }] },
      ],
    },
  });
}

/** A plugin manifest whose own hook script is present. */
function pluginWithHook(dir: string): void {
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "p",
      version: "0.1.0",
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/post.sh",
              },
            ],
          },
        ],
      },
    }),
  );
  write(dir, "hooks/post.sh", "#!/bin/sh\n");
}

/** Every file under `dir`, repo-relative → content: what a GitHub fetch hands `scanFiles`. */
function fileMap(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[relative(dir, abs)] = readFileSync(abs, "utf-8");
    }
  };
  walk(dir);
  return out;
}

const statusOf = (
  hooks: readonly { script: string; status: string }[],
  suffix: string,
): string | undefined => hooks.find((h) => h.script.endsWith(suffix))?.status;

test("a compiled hook whose RUNNER is not installed is `missing` on disk; installed, `ok`", () => {
  const dir = makeTmpDir("runner-disk");
  try {
    write(dir, ".claude/settings.json", settingsWith(WIRED));
    write(dir, ".vigiles/hooks/x.hook.mjs", "export default {};\n");
    let r = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.equal(statusOf(r.hooks, RUNNER), "missing");
    // The hook program itself is there — the finding is the runner, not it.
    assert.equal(statusOf(r.hooks, ".vigiles/hooks/x.hook.mjs"), "ok");

    write(dir, RUNNER, "// cli\n");
    r = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.equal(statusOf(r.hooks, RUNNER), "ok");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the file-map twin cannot see node_modules, so the runner is `unresolved` there, never `missing`", () => {
  const dir = makeTmpDir("runner-map");
  try {
    write(dir, ".claude/settings.json", settingsWith(WIRED));
    write(dir, ".vigiles/hooks/x.hook.mjs", "export default {};\n");
    const r = scanFiles(fileMap(dir), claudeCodeLayout, claudeCodeDialect);
    // A browser audit of a GitHub repo would otherwise accuse EVERY consumer
    // of a dead hook, because the fetch never includes node_modules.
    assert.equal(statusOf(r.hooks, RUNNER), "unresolved");
    assert.equal(statusOf(r.hooks, ".vigiles/hooks/x.hook.mjs"), "ok");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a PLUGIN repo's own project settings are path-checked too, in both twins", () => {
  // The vigiles repository's shape: hooks in `.claude-plugin/plugin.json` for
  // the people who install the plugin, and a `.claude/settings.json` for the
  // people who work on it. Only the first used to be checked.
  const dir = makeTmpDir("runner-shadowed");
  try {
    pluginWithHook(dir);
    write(
      dir,
      ".claude/settings.json",
      settingsWith('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh" || true'),
    );
    const disk = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.equal(statusOf(disk.hooks, "hooks/post.sh"), "ok");
    assert.equal(statusOf(disk.hooks, ".claude/hooks/gone.sh"), "missing");
    const map = scanFiles(fileMap(dir), claudeCodeLayout, claudeCodeDialect);
    assert.equal(statusOf(map.hooks, "hooks/post.sh"), "ok");
    assert.equal(statusOf(map.hooks, ".claude/hooks/gone.sh"), "missing");
    // Existence only: the shadowed settings do not join the other hook
    // detectors' input, so the hand-written-hook count is the manifest's alone.
    assert.equal(disk.manualHookCount, 1);
    assert.equal(map.manualHookCount, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("`lint`: a fail-open compiled hook whose runner is not installed is an ERROR, even in a plugin repo's own settings", () => {
  const dir = makeTmpDir("runner-lint");
  try {
    write(dir, "CLAUDE.md", "# CC\nRun `npm test`.\n");
    pluginWithHook(dir);
    write(dir, ".vigiles/hooks/x.hook.mjs", "export default {};\n");
    write(
      dir,
      ".claude/settings.json",
      settingsWith(
        WIRED.replaceAll("$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}"),
      ),
    );
    write(
      dir,
      ".vigilesrc.json",
      JSON.stringify({ rules: { "hook-script-exists": "error" } }),
    );
    const r = spawnSync(process.execPath, [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, /Hook-script existence check:/);
    assert.match(
      r.stdout,
      /node_modules\/vigiles\/dist\/cli\.js" is referenced but not installed/,
    );
    // The message names the reason it went unnoticed, not just the path.
    assert.match(r.stdout, /nothing to say/);
    // The hook program and the manifest's own script are present: not flagged.
    assert.doesNotMatch(r.stdout, /x\.hook\.mjs" is referenced/);
    assert.doesNotMatch(r.stdout, /post\.sh" is referenced/);

    // Installed → the same repo lints clean on this rule.
    write(dir, RUNNER, "// cli\n");
    const ok = spawnSync(process.execPath, [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.doesNotMatch(ok.stdout, /Hook-script existence check:/);
  } finally {
    cleanupTmpDir(dir);
  }
});
