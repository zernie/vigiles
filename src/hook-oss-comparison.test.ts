/**
 * Aggressive OSS comparison dogfood — compiled vigiles hooks vs the hand-written
 * shapes the ecosystem actually ships. Deterministic, model-free, CI-runnable;
 * the DISASTER_CATALOG (src/guardrail-check.ts) is the oracle. Backs the
 * comparison doc (research/hook-oss-comparison.md) with CI-checked numbers, so a
 * claim there can't drift from reality.
 *
 * The "originals" are FAITHFUL RECONSTRUCTIONS of widely-copied idioms (substring
 * blocklist, prefix/glob matcher, grep guard, wrong-exit-code), authored here —
 * the canonical sources are unlicensed (disler) so we reproduce the SHAPE, not
 * the file (the same posture as src/hook-dogfood.test.ts; provenance in the doc).
 * Each test isolates ONE failure mode so the win is non-circular: an evasion a
 * matcher structurally can't catch, a false positive, or a mis-wired protocol —
 * NOT merely "the compiled one enumerates more clauses".
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

import {
  verifyGuardrail,
  unblockedDisasters,
  assertBlocksDisasters,
} from "./guardrail-check.js";
import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const COMPILED = `node ${CLI} hook-runtime run-program ${resolve(
  REPO_ROOT,
  "examples",
  "harness",
  "safe-bash-guard.hook.mjs",
)}`;

/** Write an executable shell guard to a tmp dir; return `bash <path>`. */
function shellGuard(dir: string, name: string, body: string): string {
  const p = resolve(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return `bash ${p}`;
}

const blockedIds = (cmd: string, opts = {}): Set<string> =>
  new Set(
    verifyGuardrail(cmd, opts)
      .filter((r) => r.blocked)
      .map((r) => r.event.id),
  );

// ── Win 1: EVASION — a matcher bypass the compiled AST catches, same intent ──
// Both guards INTEND to block a force-push. The hand-written substring/prefix
// shape catches the plain form but MISSES the compound `cd … && git push -f` —
// the #30519 bypass. The compiled `command.runs("git push",{force})` catches both.
test("evasion: a substring force-push guard misses the compound form; compiled catches both", () => {
  const dir = makeTmpDir();
  try {
    // The copy-paste shape: block the literal "git push --force".
    const guard = shellGuard(
      dir,
      "fp.sh",
      `#!/usr/bin/env bash
input=$(cat)
case "$input" in
  *"git push --force"*) echo "blocked" >&2; exit 2 ;;
esac
exit 0
`,
    );
    const got = blockedIds(guard);
    // Plain force-push caught …
    assert.ok(got.has("force-push"), "hand-written catches the literal form");
    // … but the compound `git push -f` slips through (the bypass).
    assert.ok(
      !got.has("force-push-compound"),
      "hand-written MISSES the compound bypass",
    );
    // The compiled guard catches BOTH (AST leaf matching).
    const compiled = blockedIds(COMPILED, { cwd: REPO_ROOT });
    assert.ok(compiled.has("force-push"));
    assert.ok(compiled.has("force-push-compound"));
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Win 2: FALSE POSITIVE — a grep guard fires on benign text; compiled doesn't ──
test("precision: a grep guard blocks a benign echo mentioning the phrase; compiled allows it", () => {
  const dir = makeTmpDir();
  try {
    const guard = shellGuard(
      dir,
      "grep.sh",
      `#!/usr/bin/env bash
input=$(cat)
echo "$input" | grep -q "git push --force" && { echo "blocked" >&2; exit 2; }
exit 0
`,
    );
    const benign = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'echo "remember not to git push --force on main"',
      },
    };
    // The grep guard FALSE-POSITIVES on the harmless echo.
    assert.equal(runHook(guard, benign, { cwd: dir }).blocked, true);
    // The compiled guard sees the only leaf is `echo` → ALLOWS it.
    assert.equal(runHook(COMPILED, benign, { cwd: REPO_ROOT }).blocked, false);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Win 3: PROTOCOL — a mis-wired exit code is false confidence; compiled can't ──
test("protocol: an exit-1 guard looks like it blocks but doesn't; compiled uses exit 2", () => {
  const dir = makeTmpDir();
  try {
    // The classic false-confidence bug: exit 1 (not 2) — Claude Code does NOT
    // treat exit 1 as a block, so this guard enforces NOTHING despite "looking" right.
    const guard = shellGuard(
      dir,
      "exit1.sh",
      `#!/usr/bin/env bash
input=$(cat)
case "$input" in
  *"git push --force"*) echo "blocked" >&2; exit 1 ;;
esac
exit 0
`,
    );
    assert.ok(
      unblockedDisasters(verifyGuardrail(guard, { cwd: dir })).some(
        (r) => r.event.id === "force-push",
      ),
      "exit-1 guard does NOT actually block (false confidence)",
    );
    // The compiled guard never picks the exit code — it's emitted (exit 2).
    const compiled = blockedIds(COMPILED, { cwd: REPO_ROOT });
    assert.ok(compiled.has("force-push"));
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Breadth + the headline: a copy-paste blocklist's silent enumeration gaps ──
test("breadth: a faithful substring blocklist blocks 2/7; the compiled guard blocks 7/7", () => {
  const dir = makeTmpDir();
  try {
    // The widely-copied shape: a short literal blocklist. Correctly coded
    // (exit 2) — the gap is SCOPE: it only sees the exact strings it lists.
    const guard = shellGuard(
      dir,
      "blocklist.sh",
      `#!/usr/bin/env bash
input=$(cat)
case "$input" in
  *"git push --force"*) echo blocked >&2; exit 2 ;;
  *"rm -rf /"*) echo blocked >&2; exit 2 ;;
esac
exit 0
`,
    );
    const got = blockedIds(guard);
    assert.equal(
      got.size,
      2,
      "hand-written blocklist catches only its 2 literals",
    );
    assert.deepEqual([...got].sort(), ["force-push", "rm-rf"]);
    // The compiled guard blocks every disaster in the battery (no throw).
    assertBlocksDisasters(COMPILED, { cwd: REPO_ROOT });
  } finally {
    cleanupTmpDir(dir);
  }
});
