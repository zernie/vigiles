/**
 * Dogfood the shipped refs-hook through the repo's OWN unit tier (`runHook`):
 * pipe a real PostToolUse event at the built `vigiles hook-runtime refs` and assert it
 * nudges by default, blocks under `unmarked-refs: "error"`, and no-ops on a
 * clean / non-instruction file. `skills-dogfood.test.ts` proves the hook script
 * EXISTS; this proves it FIRES correctly — "test your harness, don't trust it."
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runHook } from "../../run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

const CLI = resolve(process.cwd(), "dist", "cli.js");
const REFS_HOOK = `node ${CLI} hook-runtime refs`;
const EDIT = (file: string) => ({
  hook_event_name: "PostToolUse" as const,
  tool_name: "Edit",
  tool_input: { file_path: file },
});

test("refs-hook nudges (non-blocking) on an unmarked code ref by default", () => {
  const dir = makeTmpDir("refs-hook");
  try {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "Enforce `eslint/no-console` here.\n",
    );
    const r = runHook(REFS_HOOK, EDIT("CLAUDE.md"), { cwd: dir });
    assert.equal(r.blocked, false, "warn must not block");
    assert.equal(r.exitCode, 0);
    const ctx = r.json?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(ctx, /eslint\/no-console/);
    assert.match(ctx, /unmarked linter-rule/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('refs-hook blocks (exit 2) when unmarked-refs is "error"', () => {
  const dir = makeTmpDir("refs-hook");
  try {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "Enforce `eslint/no-console` here.\n",
    );
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "unmarked-refs": "error" } }),
    );
    const r = runHook(REFS_HOOK, EDIT("CLAUDE.md"), { cwd: dir });
    assert.equal(r.blocked, true, "error must block");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /eslint\/no-console/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("refs-hook is silent when the rule is off", () => {
  const dir = makeTmpDir("refs-hook");
  try {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "Enforce `eslint/no-console` here.\n",
    );
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "unmarked-refs": false } }),
    );
    const r = runHook(REFS_HOOK, EDIT("CLAUDE.md"), { cwd: dir });
    assert.equal(r.blocked, false);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("refs-hook ignores a clean instruction file and non-instruction files", () => {
  const dir = makeTmpDir("refs-hook");
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "Run the build before committing.\n");
    writeFileSync(join(dir, "notes.md"), "Enforce `eslint/no-console` here.\n");

    const clean = runHook(REFS_HOOK, EDIT("CLAUDE.md"), { cwd: dir });
    assert.equal(clean.exitCode, 0);
    assert.equal(clean.stdout.trim(), "");

    const nonInstruction = runHook(REFS_HOOK, EDIT("notes.md"), { cwd: dir });
    assert.equal(nonInstruction.exitCode, 0);
    assert.equal(nonInstruction.stdout.trim(), "");
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// THE CONFIG IS READ FROM THE PROJECT, NOT FROM WHEREVER THE PROCESS STANDS.
//
// cosmiconfig searches from the process's cwd and walks up. On a CLI verb that
// is right — the user is standing in the project they mean. On a hook it is
// not: the process has no stable cwd, so the rail used to read a different
// project's `.vigilesrc.json`, or none at all.
//
// And the failure runs the DANGEROUS way. A config that is not found means
// DEFAULTS, so a rule the author deliberately switched off comes back on — the
// hook nudges about something the project already decided it did not want, and
// nothing in the output distinguishes that from a project that never configured
// the rule. Silence would have been the safe miss; this is the loud one.
// ---------------------------------------------------------------------------
test("refs-hook honours `off` from the PROJECT's config, not the process's", () => {
  const dir = makeTmpDir("refs-hook-cfg");
  const elsewhere = makeTmpDir("refs-hook-cfg-elsewhere");
  try {
    const md = join(dir, "CLAUDE.md");
    writeFileSync(md, "Enforce `eslint/no-console` here.\n");
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "unmarked-refs": "off" } }),
    );

    // The probe is real: with the rule ON (no config at all) the same file DOES
    // nudge. Without this half, "silent" proves nothing — a hook that never
    // fires is silent too.
    const noConfig = makeTmpDir("refs-hook-cfg-on");
    try {
      writeFileSync(
        join(noConfig, "CLAUDE.md"),
        "Enforce `eslint/no-console` here.\n",
      );
      const on = runHook(REFS_HOOK, EDIT("CLAUDE.md"), {
        cwd: noConfig,
        env: { CLAUDE_PROJECT_DIR: noConfig },
      });
      assert.match(
        on.json?.hookSpecificOutput?.additionalContext ?? "",
        /unmarked linter-rule/,
        "the probe must fire when the rule is on",
      );
    } finally {
      cleanupTmpDir(noConfig);
    }

    // cwd == root: the `off` is honoured.
    const here = runHook(REFS_HOOK, EDIT(md), {
      cwd: dir,
      env: { CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(here.json?.hookSpecificOutput?.additionalContext ?? "", "");

    // …and from a FOREIGN cwd it is honoured just the same. Before the fix the
    // config was searched from `elsewhere`, found nothing, and the disabled rule
    // nudged.
    const crossed = runHook(REFS_HOOK, EDIT(md), {
      cwd: elsewhere,
      env: { CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(
      crossed.json?.hookSpecificOutput?.additionalContext ?? "",
      "",
      "a rule the project switched off must stay off from any directory",
    );
    assert.equal(crossed.exitCode, 0);
  } finally {
    cleanupTmpDir(elsewhere);
    cleanupTmpDir(dir);
  }
});
