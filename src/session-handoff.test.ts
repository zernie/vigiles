/**
 * SessionStart handoff hook — the context-budget lever (dogfood).
 *
 * `.claude/hooks/session-handoff.sh` injects HANDOFF.md as SessionStart
 * `additionalContext` so a new session starts oriented from one ~2k-token
 * pointer file instead of re-reading CLAUDE.md + the research docs. This drives
 * the REAL script through `runHook` (the unit tier — no `claude`, no model) so
 * the injection contract can't silently break: a present HANDOFF.md is emitted
 * as `additionalContext`, an absent one is a clean no-op (fail-open).
 *
 * The hook reads HANDOFF.md from the git toplevel, falling back to `pwd` — so a
 * tmp cwd (no git) exercises the fallback path the way a fresh clone would.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runHook } from "./run-hook.js";

// __dirname is src/ when vitest resolves the .ts source → ".." is the repo root.
const SCRIPT = resolve(
  import.meta.dirname,
  "..",
  ".claude/hooks/session-handoff.sh",
);
const CMD = `bash ${SCRIPT}`;

test("present HANDOFF.md → injected as SessionStart additionalContext", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  try {
    const body = "# HANDOFF\n## Now: wiring the handoff hook\n## Next: A1\n";
    writeFileSync(join(dir, "HANDOFF.md"), body);

    const r = runHook(CMD, { hook_event_name: "SessionStart" }, { cwd: dir });

    assert.equal(r.exitCode, 0);
    assert.equal(r.blocked, false);
    assert.equal(
      r.json?.hookSpecificOutput?.hookEventName,
      "SessionStart",
      "must declare the SessionStart event",
    );
    assert.equal(
      r.json?.hookSpecificOutput?.additionalContext,
      body,
      "the whole handoff is injected verbatim",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absent HANDOFF.md → clean no-op (fail-open, no injection)", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-none-"));
  try {
    const r = runHook(CMD, { hook_event_name: "SessionStart" }, { cwd: dir });

    assert.equal(r.exitCode, 0, "a missing handoff never fails the session");
    assert.equal(r.blocked, false);
    assert.equal(r.stdout.trim(), "", "no output → nothing injected");
    assert.equal(r.json, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
