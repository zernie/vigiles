/**
 * The SessionStart hook-check (#312) — driven against the REAL built CLI, and the
 * script it writes is run with a real `sh`.
 *
 * What it is: when `vigiles compile` wires hooks it also wires ONE `SessionStart`
 * command that runs `.vigiles/hook-check.sh`. The script lists the files those
 * wirings need (the local runtime and each hook) and, if any is missing, prints
 * the cure into the first turn. That is the whole job.
 *
 * Three properties are load-bearing, and each has its own test:
 *
 *   1. It runs where nothing else does. The state it reports is "node_modules is
 *      not installed", so it is plain POSIX `sh` — asserted by running it with an
 *      EMPTY `PATH` (builtins only: no `node`, no `grep`, no vigiles).
 *   2. It only PRINTS. It always exits 0 — a check that could exit 2 at session
 *      start would be a new way to wedge the session it is trying to help.
 *   3. Compile is idempotent about it: one entry, byte-identical on recompile,
 *      the user's own SessionStart hooks untouched.
 *
 * What it is NOT: a fix. A gate whose files are missing still refuses every
 * command (the install included); this only says so before the first one is tried.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");

const GATE = `import { experimental_defineHook, deny, allow } from "vigiles/hook";
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => (e.command.runs("git push", { force: true }) ? deny("no") : allow()),
});
`;
const NUDGE = `import { experimental_defineReact, tools, notice } from "vigiles/hook";
export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Write"),
  react: () => notice("remember the checklist"),
});
`;

interface Settings {
  hooks: Record<
    string,
    { matcher?: string; hooks: { type: string; command: string }[] }[]
  >;
}

function project(hooks: Record<string, string> = {}): string {
  const dir = makeTmpDir("hook-check");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, "node_modules", "vigiles"), "dir");
  mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    '{ "name": "t", "private": true }\n',
  );
  for (const [name, src] of Object.entries(hooks)) {
    writeFileSync(join(dir, ".vigiles", "hooks", name), src);
  }
  return dir;
}

function compile(
  dir: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, "compile", ...args], {
    cwd: dir,
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function settings(dir: string): Settings {
  return JSON.parse(
    readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
  ) as Settings;
}

/** The SessionStart commands that mention the check script. */
function checkCommands(s: Settings): string[] {
  return (s.hooks.SessionStart ?? [])
    .flatMap((e) => e.hooks.map((h) => h.command))
    .filter((c) => c.includes("hook-check.sh"));
}

/** The one check command compile wired — failing loudly when there is not one. */
function theCheck(dir: string): string {
  const cmds = checkCommands(settings(dir));
  assert.equal(
    cmds.length,
    1,
    `one SessionStart check wired, got ${cmds.length}`,
  );
  return cmds[0];
}

/** The exact string the harness runs, run the way it runs it. */
function runCheck(
  dir: string,
  command: string,
  env: Record<string, string> = { CLAUDE_PROJECT_DIR: dir },
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("sh", ["-c", command], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function context(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

test("compile wires ONE SessionStart check, as a nudge (`|| exit 0`), next to the hooks", () => {
  const dir = project({ "guard.hook.mjs": GATE, "nudge.hook.mjs": NUDGE });
  try {
    assert.equal(compile(dir).status, 0);
    const cmds = checkCommands(settings(dir));
    assert.equal(cmds.length, 1, "exactly one check entry, not one per hook");
    assert.match(
      cmds[0],
      /^sh "\$\{CLAUDE_PROJECT_DIR\}\/\.vigiles\/hook-check\.sh" \|\| exit 0$/,
    );
    assert.ok(existsSync(join(dir, ".vigiles", "hook-check.sh")));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("healthy repo: the check is SILENT and exits 0", () => {
  const dir = project({ "guard.hook.mjs": GATE, "nudge.hook.mjs": NUDGE });
  try {
    assert.equal(compile(dir).status, 0);
    const cmd = theCheck(dir);
    const r = runCheck(dir, cmd);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", "nothing to say when everything resolves");
    assert.equal(r.stderr, "");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a missing hook file: it names the file, says the cure, and still exits 0", () => {
  const dir = project({ "guard.hook.mjs": GATE, "nudge.hook.mjs": NUDGE });
  try {
    assert.equal(compile(dir).status, 0);
    const cmd = theCheck(dir);
    rmSync(join(dir, ".vigiles", "hooks", "nudge.hook.mjs"));
    const r = runCheck(dir, cmd);
    assert.equal(r.code, 0, "a notice, never a gate");
    const said = context(r.stdout);
    assert.match(said, /\.vigiles\/hooks\/nudge\.hook\.mjs/);
    assert.doesNotMatch(said, /guard\.hook\.mjs/, "names only what is missing");
    assert.match(said, /npm ci/);
    assert.match(said, /outside this session/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a missing RUNTIME (fresh container, no node_modules): it says so, and still exits 0", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    assert.equal(compile(dir).status, 0);
    const cmd = theCheck(dir);
    rmSync(join(dir, "node_modules"), { recursive: true });
    const r = runCheck(dir, cmd);
    assert.equal(r.code, 0);
    assert.match(context(r.stdout), /node_modules\/vigiles\/dist\/cli\.js/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the script needs NOTHING installed: it runs under an empty PATH, healthy and not", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    assert.equal(compile(dir).status, 0);
    const script = join(dir, ".vigiles", "hook-check.sh");
    // PATH="" leaves shell builtins only: no node, no grep, no ls, no vigiles.
    // Both halves matter: a script that leaned on an external binary would report
    // EVERYTHING missing here, so the healthy half must stay silent.
    const run = () =>
      spawnSync("/bin/sh", [script], {
        cwd: dir,
        encoding: "utf-8",
        env: { PATH: "" },
      });
    const healthy = run();
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.equal(
      healthy.stdout,
      "",
      "all present: silent, with no binary on PATH",
    );
    assert.equal(healthy.stderr, "");

    rmSync(join(dir, "node_modules"), { recursive: true });
    const broken = run();
    assert.equal(broken.status, 0, broken.stderr);
    assert.match(
      context(broken.stdout),
      /node_modules\/vigiles\/dist\/cli\.js/,
    );
    assert.equal(broken.stderr, "");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("it exits 0 whatever the project directory is — and a missing script is itself harmless", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    assert.equal(compile(dir).status, 0);
    const script = join(dir, ".vigiles", "hook-check.sh");
    // The script, pointed at a directory that does not exist: everything is
    // "missing", and it still only prints.
    const elsewhere = spawnSync("/bin/sh", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: { PATH: "", CLAUDE_PROJECT_DIR: join(dir, "nowhere") },
    });
    assert.equal(elsewhere.status, 0, elsewhere.stderr);
    assert.match(context(elsewhere.stdout), /not installed/);

    // The wired command when the script itself is gone (`.vigiles/` not
    // committed, a partial checkout): `sh` fails, the `|| exit 0` absorbs it, and
    // the session starts as if the check were not there.
    rmSync(script);
    const r = runCheck(dir, theCheck(dir));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("recompile is idempotent about the check: same bytes, one entry, user hooks untouched", () => {
  const dir = project({ "guard.hook.mjs": GATE, "nudge.hook.mjs": NUDGE });
  try {
    // A hook the user wrote by hand, sharing the event.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo mine" }],
            },
          ],
        },
      }),
    );
    assert.equal(compile(dir).status, 0);
    const settingsFile = join(dir, ".claude", "settings.json");
    const scriptFile = join(dir, ".vigiles", "hook-check.sh");
    const s1 = readFileSync(settingsFile, "utf-8");
    const c1 = readFileSync(scriptFile, "utf-8");

    assert.equal(compile(dir).status, 0);
    assert.equal(readFileSync(settingsFile, "utf-8"), s1, "settings stable");
    assert.equal(readFileSync(scriptFile, "utf-8"), c1, "script stable");

    // Compiling ONE hook must not forget the others the settings already name.
    assert.equal(compile(dir, ".vigiles/hooks/guard.hook.mjs").status, 0);
    assert.equal(
      readFileSync(scriptFile, "utf-8"),
      c1,
      "additive, not rebuilt",
    );

    const s = settings(dir);
    assert.equal(checkCommands(s).length, 1);
    const all = s.hooks.SessionStart.flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    assert.ok(all.includes("echo mine"), "the user's own hook survives");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("it covers a hook some OTHER writer wired, once compile has seen the settings", () => {
  // The measured shape: a dependency's `init` wrote its own entries, pointing into
  // node_modules, with no suffix. `compile` did not write them, but it reads the
  // settings it merges into, so the check names their files too.
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write",
              hooks: [
                {
                  type: "command",
                  command:
                    'node "$CLAUDE_PROJECT_DIR/node_modules/fakepkg/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/node_modules/fakepkg/hooks/status.hook.mjs"',
                },
              ],
            },
          ],
        },
      }),
    );
    assert.equal(compile(dir).status, 0);
    const cmd = theCheck(dir);
    const said = context(runCheck(dir, cmd).stdout);
    assert.match(said, /node_modules\/fakepkg\/hooks\/status\.hook\.mjs/);
    assert.match(said, /node_modules\/fakepkg\/dist\/cli\.js/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("commands that are not vigiles runtime wirings are not the check's business", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: "command", command: "npx prettier --check ." },
                { type: "command", command: "bash scripts/not-built-yet.sh" },
                {
                  type: "command",
                  command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/post-edit.sh",
                },
              ],
            },
          ],
        },
      }),
    );
    assert.equal(compile(dir).status, 0);
    const script = readFileSync(
      join(dir, ".vigiles", "hook-check.sh"),
      "utf-8",
    );
    assert.doesNotMatch(script, /prettier|not-built-yet|post-edit/);
    // …and since nothing it names is missing, a healthy repo stays silent.
    const cmd = theCheck(dir);
    assert.equal(runCheck(dir, cmd).stdout, "");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a path the check cannot quote safely is REPORTED by compile, not silently dropped", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/odd:dir/x.hook.mjs" || exit 0',
                },
              ],
            },
          ],
        },
      }),
    );
    const r = compile(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /odd:dir\/x\.hook\.mjs/);
    assert.match(r.stderr, /NOT covered/);
    // …and the script never carries it into a shell string or a JSON string.
    const script = readFileSync(
      join(dir, ".vigiles", "hook-check.sh"),
      "utf-8",
    );
    assert.doesNotMatch(script, /odd:dir/);
    assert.match(
      script,
      /\.vigiles\/hooks\/guard\.hook\.mjs/,
      "the rest is still covered",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("no hooks, no check: compiling a repo without hooks writes neither the script nor the entry", () => {
  const dir = project();
  try {
    writeFileSync(
      join(dir, "x.md.spec.ts"),
      'import { instructionFile, guidance } from "vigiles/spec";\nexport default instructionFile({ sections: { scope: "s" }, rules: { a: guidance("g") } });\n',
    );
    compile(dir, "x.md.spec.ts");
    assert.equal(existsSync(join(dir, ".vigiles", "hook-check.sh")), false);
    assert.equal(existsSync(join(dir, ".claude", "settings.json")), false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("Codex: the same check lands in config.toml as a flat SessionStart entry", () => {
  const dir = project({ "guard.hook.mjs": GATE });
  try {
    const r = compile(dir, "--harness=codex");
    assert.equal(r.status, 0, r.stderr);
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf-8");
    assert.match(toml, /\[\[hooks\.SessionStart\]\]/);
    assert.match(toml, /command = "sh [^"]*hook-check\.sh[^"]*\|\| exit 0"/);
  } finally {
    cleanupTmpDir(dir);
  }
});
