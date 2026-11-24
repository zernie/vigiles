/**
 * Stop hook — STALE HANDOFF.md catch (the "don't forget the handoff" fix, dogfood).
 *
 * `.claude/hooks/session-handoff-check.sh` blocks the stop (exit 2) and nudges the
 * agent to refresh HANDOFF.md once >= THRESHOLD commits land since it was last
 * committed. Driven through `runHook` (the unit tier — no `claude`, no model) so the
 * nudge contract can't silently break; fail-open everywhere it can't decide.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runHook } from "./run-hook.js";

const SCRIPT = resolve(
  import.meta.dirname,
  "..",
  ".claude/hooks/session-handoff-check.sh",
);
const CMD = `bash ${SCRIPT}`;
const STOP = { hook_event_name: "Stop" } as const;
const T1 = { VIGILES_HANDOFF_THRESHOLD: "1" };

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function repoWithHandoff(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-check-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "HANDOFF.md"), "# HANDOFF\n");
  git(dir, "add", "HANDOFF.md");
  git(dir, "commit", "-q", "-m", "handoff");
  return dir;
}

function commitN(dir: string, n: number): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}`);
    git(dir, "add", `f${i}.txt`);
    git(dir, "commit", "-q", "-m", `c${i}`);
  }
}

test("non-git dir → fail-open (no nudge)", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-nogit-"));
  try {
    writeFileSync(join(dir, "HANDOFF.md"), "# HANDOFF\n");
    const r = runHook(CMD, STOP, { cwd: dir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff fresh (0 commits since) → no nudge", () => {
  const dir = repoWithHandoff();
  try {
    const r = runHook(CMD, STOP, { cwd: dir, env: T1 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commits past threshold → blocks the stop with a STALE nudge", () => {
  const dir = repoWithHandoff();
  try {
    commitN(dir, 2);
    const r = runHook(CMD, STOP, { cwd: dir, env: T1 });
    assert.equal(r.exitCode, 2, "exit 2 blocks the stop");
    assert.equal(r.blocked, true);
    assert.match(r.stderr, /STALE/, "the nudge names the staleness");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop guard: stop_hook_active → no re-block even when stale", () => {
  const dir = repoWithHandoff();
  try {
    commitN(dir, 3);
    const r = runHook(
      CMD,
      { hook_event_name: "Stop", stop_hook_active: true },
      { cwd: dir, env: T1 },
    );
    assert.equal(r.exitCode, 0, "already continuing from a stop → don't loop");
    assert.equal(r.blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff being edited (uncommitted) → no nudge", () => {
  const dir = repoWithHandoff();
  try {
    commitN(dir, 3);
    writeFileSync(join(dir, "HANDOFF.md"), "# HANDOFF\nedited\n"); // dirty, uncommitted
    const r = runHook(CMD, STOP, { cwd: dir, env: T1 });
    assert.equal(r.exitCode, 0, "the agent is already on the handoff");
    assert.equal(r.blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
