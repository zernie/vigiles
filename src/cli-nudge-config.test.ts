/**
 * The edit-time `untested-skill` nudge must obey the SAME `.vigilesrc.json` the
 * linter obeys — driven through the REAL built CLI, because the defect was in
 * the wiring and nowhere else.
 *
 * Reproduced 2026-08-12 on the fixtures below (`vigiles hook-runtime
 * eval-lock-nudge`, the PostToolUse entry point):
 *
 *   rules: { "untested-skill": false }
 *     lint  → prints nothing
 *     nudge → "nothing measures whether it still does what it claims"
 *
 *   rules: { "untested-skill": ["warn", { include: ["**\/*.check.mjs"] }] }
 *     lint  → "all 1 surface(s) have a test or eval"
 *     nudge → "no test or eval covers it"
 *
 * The nudge called the detector with `basePath` alone, so it read the DEFAULTS
 * whatever the repo had configured. A hook that contradicts the linter of the
 * same repo, in the same second, is worse than one that says nothing: it teaches
 * the agent that both are noise.
 *
 * Deterministic, model-free, offline → the free unit tier, like
 * cli-untested-options.test.ts (whose fixture shape this follows).
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

// __dirname is src/ when vitest resolves the .ts source → ".." is the repo root.
const CLI = resolve(__dirname, "..", "dist", "cli.js");
const SKILL = ".claude/skills/demo/SKILL.md";
/** How `vigiles lint` prints an untested skill on stdout (the finding + fix). */
const UNTESTED_IN_LINT = /skill \.claude\/skills\/demo\/SKILL\.md — add e\.g\./;

let dir: string;

function write(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** `vigiles lint`'s stdout — the command exits non-zero on findings. */
function lint(): string {
  try {
    return execFileSync("node", [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60000,
    });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

/** The PostToolUse nudge for an edit to `file` — "" when it stays silent. */
function nudge(file = SKILL): string {
  const out = execFileSync("node", [CLI, "hook-runtime", "eval-lock-nudge"], {
    cwd: dir,
    encoding: "utf-8",
    input: JSON.stringify({ tool_input: { file_path: file } }),
    stdio: "pipe",
    timeout: 60000,
  });
  if (out.trim() === "") return "";
  const j = JSON.parse(out) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return j.hookSpecificOutput?.additionalContext ?? "";
}

beforeEach(() => {
  dir = makeTmpDir("cli-nudge-config");
  write("package.json", JSON.stringify({ name: "demo-repo" }));
  write(SKILL, "---\nname: demo\ndescription: demo skill\n---\n\nBody.\n");
});

afterEach(() => {
  cleanupTmpDir(dir);
});

test("the control: with no config, lint and the nudge both say untested", () => {
  // Without this half a fix that simply silenced the hook would pass everything
  // else in this file.
  assert.match(lint(), UNTESTED_IN_LINT);
  assert.match(nudge(), /no test or eval covers it/);
});

test("a DISABLED untested-skill rule silences the nudge, as it silences lint", () => {
  write(
    ".vigilesrc.json",
    JSON.stringify({ rules: { "untested-skill": false } }),
  );
  assert.doesNotMatch(lint(), UNTESTED_IN_LINT);
  assert.equal(
    nudge(),
    "",
    "a rule the author switched off must not come back through a hook",
  );
});

test("…and disabling it for SKILLS only still leaves the other rules alone", () => {
  // The scoping half: `untested-hook` is untouched, so the nudge must not be
  // silenced by a blanket "any rule off" reading — it is silent for THIS edit
  // because the SKILL kind is off.
  write("hooks/a.sh", "#!/bin/sh\nexit 0\n");
  write(
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "sh hooks/a.sh" }],
          },
        ],
      },
    }),
  );
  write(
    ".vigilesrc.json",
    JSON.stringify({ rules: { "untested-skill": false } }),
  );
  assert.match(lint(), /hooks\/a\.sh/, "the hook rule still reports");
  assert.equal(nudge(), "", "but an edited SKILL.md is not nudged");
});

test("a configured testGlob counts as coverage for the nudge too", () => {
  // The sharper half: the rule is ON, so silence is not the answer — the nudge
  // must see the SAME covering file lint sees, and move on to the eval gap.
  write(".claude/skills/demo/demo.check.mjs", "// covers demo\n");
  write(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { "untested-skill": ["warn", { include: ["**/*.check.mjs"] }] },
    }),
  );
  assert.doesNotMatch(
    lint(),
    UNTESTED_IN_LINT,
    "precondition: lint counts the configured test",
  );
  const msg = nudge();
  assert.doesNotMatch(
    msg,
    /no test or eval covers it/,
    "the nudge contradicted the linter of the same repo",
  );
  assert.match(msg, /FIRES/, "the honest remaining gap is the eval tier");
});

test("…and an `exclude` that hides the covering test is honoured too", () => {
  // The inverse direction, so the test cannot pass by ignoring options in only
  // one direction: here the config REMOVES coverage lint would otherwise find.
  write(".claude/skills/demo/demo.harness.mjs", "// covers demo\n");
  assert.doesNotMatch(nudge(), /no test or eval covers it/); // precondition
  write(
    ".vigilesrc.json",
    JSON.stringify({
      rules: {
        "untested-skill": ["warn", { exclude: ["**/*.harness.mjs"] }],
      },
    }),
  );
  assert.match(lint(), UNTESTED_IN_LINT);
  assert.match(nudge(), /no test or eval covers it/);
});

// ─── …and the same detector must see the repo's OWN harness layout ─────────────
//
// 🔴 Reproduced 2026-08-12. `skillTestNudge` was called with `basePath` alone, so
// `test-coverage.ts` fell back to `claudeCodeLayout`. In a Codex repo whose only
// surface is `.codex/skills/demo/SKILL.md`, discovery returned ZERO surfaces, the
// edited skill matched nothing, and the hook said nothing at all — while `vigiles
// lint`, which threads `adapter.layout` into the very same function, reported that
// skill as untested. Silence is the worst failure mode a nudge has: nobody goes
// looking for a message that never arrives.
const CODEX_SKILL = ".codex/skills/demo/SKILL.md";

test("a CODEX repo gets the nudge its own linter gives — the layout is not assumed", () => {
  write(".codex/config.toml", "[mcp_servers]\n");
  write(
    CODEX_SKILL,
    "---\nname: demo\ndescription: demo skill\n---\n\nBody.\n",
  );
  assert.match(
    lint(),
    /skill \.codex\/skills\/demo\/SKILL\.md — add e\.g\./,
    "precondition: lint resolves the Codex adapter and sees the surface",
  );
  assert.match(
    nudge(CODEX_SKILL),
    /no test or eval covers it/,
    "the hook must not fall back to the Claude Code layout and go quiet",
  );
});

test("…and the Claude Code repo it used to assume is completely unaffected", () => {
  // The quiet half on the shape that already worked: resolving the layout must
  // not change the answer where the fallback happened to be correct.
  assert.match(lint(), UNTESTED_IN_LINT);
  assert.match(nudge(), /no test or eval covers it/);
  // A repo carrying BOTH markers still resolves to one harness and still speaks.
  write(".codex/config.toml", "[mcp_servers]\n");
  write(
    CODEX_SKILL,
    "---\nname: demo\ndescription: demo skill\n---\n\nBody.\n",
  );
  assert.notEqual(nudge(CODEX_SKILL), "");
});
