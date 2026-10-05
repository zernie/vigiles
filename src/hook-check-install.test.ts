/**
 * `installHookCheck` called directly, with real adapters and a scratch directory.
 * (`hook-check.test.ts` covers the same feature through the built CLI; this file
 * is the quick version that also checks the cases the CLI cannot easily reach:
 * several harnesses at once, a harness with no shell hooks, and the warning.)
 */
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";
import { codexAdapter } from "./adapters/codex/adapter.js";
import { opencodeAdapter } from "./adapters/opencode/adapter.js";
import { installHookCheck } from "./hook-check-install.js";

const WIRED =
  'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/g.hook.mjs" || exit 2';

function project(command = WIRED): string {
  const dir = makeTmpDir("hook-check-install");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command }] },
        ],
      },
    }),
  );
  return dir;
}

/** Run `fn` with console output captured, so the tests stay quiet. */
function quietly<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((m: unknown) => void warnings.push(String(m)));
  try {
    return { result: fn(), warnings };
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

const settingsOf = (dir: string): string =>
  readFileSync(join(dir, ".claude", "settings.json"), "utf-8");

test("writes the script and one SessionStart entry; a second run changes nothing", () => {
  const dir = project();
  try {
    quietly(() => {
      installHookCheck([claudeCodeAdapter], dir);
    });
    const script = readFileSync(
      join(dir, ".vigiles", "hook-check.sh"),
      "utf-8",
    );
    assert.match(script, /'\.vigiles\/hooks\/g\.hook\.mjs'/);
    const settings = JSON.parse(settingsOf(dir)) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.match(
      settings.hooks.SessionStart[0].hooks[0].command,
      /^sh .*hook-check\.sh.* \|\| exit 0$/,
    );

    const before = settingsOf(dir);
    quietly(() => {
      installHookCheck([claudeCodeAdapter], dir);
    });
    assert.equal(settingsOf(dir), before);
    assert.equal(
      readFileSync(join(dir, ".vigiles", "hook-check.sh"), "utf-8"),
      script,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a harness whose settings file does not exist yet is left alone", () => {
  const dir = makeTmpDir("hook-check-install");
  try {
    quietly(() => {
      installHookCheck([claudeCodeAdapter], dir);
    });
    assert.equal(existsSync(join(dir, ".vigiles", "hook-check.sh")), false);
    assert.equal(existsSync(join(dir, ".claude")), false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a harness without shell hooks is skipped, not an error", () => {
  const dir = project();
  try {
    quietly(() => {
      installHookCheck([opencodeAdapter, claudeCodeAdapter], dir);
    });
    assert.ok(existsSync(join(dir, ".vigiles", "hook-check.sh")));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("with Claude Code and Codex together, both configs get the entry and share one script", () => {
  const dir = project();
  try {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[[hooks.PreToolUse]]\nmatcher = "^Bash$"\ncommand = "npx vigiles hook-runtime run-program .vigiles/hooks/c.hook.mjs || exit 2"\n',
    );
    quietly(() => {
      installHookCheck([claudeCodeAdapter, codexAdapter], dir);
    });
    const script = readFileSync(
      join(dir, ".vigiles", "hook-check.sh"),
      "utf-8",
    );
    // The Codex-only hook and the Claude-Code-only hook are both in it.
    assert.match(script, /\.vigiles\/hooks\/c\.hook\.mjs/);
    assert.match(script, /\.vigiles\/hooks\/g\.hook\.mjs/);
    assert.match(
      readFileSync(join(dir, ".codex", "config.toml"), "utf-8"),
      /\[\[hooks\.SessionStart\]\]/,
    );
    assert.match(settingsOf(dir), /hook-check\.sh/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a path it cannot quote safely is warned about by name and kept out of the script", () => {
  const dir = project(
    'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/odd:dir/x.hook.mjs" || exit 0',
  );
  try {
    const { warnings } = quietly(() => {
      installHookCheck([claudeCodeAdapter], dir);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /odd:dir\/x\.hook\.mjs/);
    assert.match(warnings[0], /NOT covered/);
    // Only the runtime path is left, so the script exists but never names the odd one.
    assert.doesNotMatch(
      readFileSync(join(dir, ".vigiles", "hook-check.sh"), "utf-8"),
      /odd:dir/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
