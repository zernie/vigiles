/**
 * Hook lines are read by IDENTITY, never parsed (#361, #362).
 *
 * A line is `compiled` exactly when it equals the line `vigiles compile` would
 * write for one of the repo's hook sources; its files (runtime, program, stamp)
 * come from that plan and are what `hook-script-exists` checks. Every other line
 * is one `hand-written-hook` finding that names it. A line `compile`'s merge key
 * assigns to a hook source but that is not the planned line is "edited or
 * stale: recompile".
 *
 * The honest loss, pinned below: a hand-written hook whose script is missing is
 * no longer detected statically. The cure is to compile it; `vigiles test`
 * (`runHook`) checks a hand-written hook by running it.
 *
 * Claude-Code-shaped fixtures (`.claude/settings.json`, `${CLAUDE_PROJECT_DIR}`),
 * so this lives in the adapter; the plan itself is tested harness-neutrally in
 * `core/hook-command.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { scanPlugin } from "../../scan.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

const REPO = resolve(__dirname, "..", "..", "..");
const CLI = join(REPO, "dist", "cli.js");

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

/** Opt in to `hand-written-hook` — it is off by default (its cure is an experimental API). */
function optIn(dir: string): void {
  write(
    dir,
    ".vigilesrc.json",
    JSON.stringify({ rules: { "hand-written-hook": "warn" } }),
  );
}

function cli(
  dir: string,
  ...args: string[]
): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout + r.stderr };
}

/** The `hand-written-hook` lines `lint` prints. */
const handWritten = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((l) => /vigiles did not write this line|edited or stale/.test(l));

/** A consumer project with vigiles installed (a link to this build) and one compiled react hook. */
function compiledProject(name: string): string {
  const dir = makeTmpDir(name);
  write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
  optIn(dir);
  write(dir, "package.json", JSON.stringify({ name: "consumer" }));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REPO, join(dir, "node_modules", "vigiles"), "dir");
  write(
    dir,
    ".vigiles/hooks/x.hook.mjs",
    'import { experimental_defineReact, nothing } from "vigiles/hook";\n' +
      'export default experimental_defineReact({ on: "PostToolUse", react: () => nothing() });\n',
  );
  const compiled = cli(dir, "compile", ".vigiles/hooks/x.hook.mjs");
  assert.equal(compiled.status, 0, compiled.stdout);
  return dir;
}

test("the line `compile` writes is read back as compiled — writer and reader are one plan", () => {
  const dir = compiledProject("hwh-compiled");
  try {
    const r = cli(dir, "lint");
    assert.deepEqual(handWritten(r.stdout), [], r.stdout);
    assert.doesNotMatch(r.stdout, /is referenced but/);
    // Its files come from the plan: runtime, program and stamp are all checked.
    const scripts = scanPlugin(
      dir,
      claudeCodeLayout,
      claudeCodeDialect,
    ).hooks.map((h) => h.script.slice(dir.length + 1));
    assert.ok(
      scripts.includes("node_modules/vigiles/dist/cli.js"),
      scripts.join(),
    );
    assert.ok(scripts.includes(".vigiles/hooks/x.hook.mjs"), scripts.join());
    assert.ok(
      scripts.includes(".vigiles/hooks/x.hook.mjs.json"),
      scripts.join(),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a file a compiled hook needs is missing → hook-script-exists names it", () => {
  const dir = compiledProject("hwh-runtime-gone");
  try {
    // The runtime the line starts: a dependency that is not installed.
    rmSync(join(dir, "node_modules", "vigiles"));
    const r = spawnSync(process.execPath, [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.match(r.stdout, /Hook-script existence check:/);
    assert.match(
      r.stdout,
      /node_modules\/vigiles\/dist\/cli\.js" is referenced but not installed/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("an edited compiled line is stale: recompile — found by compile's merge key, not by reading the line", () => {
  const dir = compiledProject("hwh-stale");
  try {
    const path = join(dir, ".claude", "settings.json");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("|| exit 0", "|| true"),
    );
    const lines = handWritten(cli(dir, "lint").stdout);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(
      lines[0] ?? "",
      /wires \.vigiles\/hooks\/x\.hook\.mjs .*edited or stale/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a hand-written hook is one finding that names it; nothing in it is taken for a script", () => {
  const dir = makeTmpDir("hwh-sh-c");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    optIn(dir);
    write(
      dir,
      ".claude/settings.json",
      settings("sh -c 'node hooks/gone.mjs'"),
    );
    const scan = scanPlugin(dir, claudeCodeLayout, claudeCodeDialect);
    assert.deepEqual(scan.hooks, []);
    assert.deepEqual(scan.handWrittenHooks, [
      {
        event: "PostToolUse",
        command: "sh -c 'node hooks/gone.mjs'",
        kind: "hand-written",
      },
    ]);
    const r = cli(dir, "lint");
    assert.equal(r.status, 0, r.stdout);
    const lines = handWritten(r.stdout);
    assert.equal(lines.length, 1, r.stdout);
    assert.match(
      lines[0] ?? "",
      /PostToolUse hook `sh -c 'node hooks\/gone\.mjs'`/,
    );
    assert.match(r.stdout, /vigiles\/hook/);
    assert.match(r.stdout, /docs\/compiled-hooks\.md/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the honest loss: a hand-written hook's missing script is NOT reported — compile it, or run it", () => {
  const dir = makeTmpDir("hwh-literal-missing");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    optIn(dir);
    write(
      dir,
      ".claude/settings.json",
      settings('"$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.sh'),
    );
    const r = cli(dir, "lint");
    assert.doesNotMatch(r.stdout, /Hook-script existence check:/);
    assert.equal(handWritten(r.stdout).length, 1, r.stdout);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("three hand-written hooks are three findings; `false` in the config turns the rule off", () => {
  const dir = makeTmpDir("hwh-three");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    optIn(dir);
    write(
      dir,
      ".claude/settings.json",
      settings(
        "npx prettier --check .",
        'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/ok.sh" || true',
        '[ -f x ] && echo "$x"',
      ),
    );
    assert.equal(handWritten(cli(dir, "lint").stdout).length, 3);
    write(
      dir,
      ".vigilesrc.json",
      JSON.stringify({ rules: { "hand-written-hook": false } }),
    );
    assert.deepEqual(handWritten(cli(dir, "lint").stdout), []);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("off by default: without opting in, a hand-written hook is not reported", () => {
  const dir = makeTmpDir("hwh-default-off");
  try {
    write(dir, "CLAUDE.md", "# x\nRun `npm test`.\n");
    write(dir, ".claude/settings.json", settings("npx prettier --check ."));
    assert.deepEqual(handWritten(cli(dir, "lint").stdout), []);
  } finally {
    cleanupTmpDir(dir);
  }
});
