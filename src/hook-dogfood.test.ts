/**
 * OSS dogfood — does a COMPILED hook actually close the gaps a hand-written
 * safety guard leaves? Measured deterministically with our own DISASTER_CATALOG
 * as the oracle (no model, no key, runs in CI).
 *
 * The "before" is the SHAPE of a widely-copied safety hook: a string-match
 * blocklist. We ran the real one (disler/claude-code-hooks-mastery's
 * `pre_tool_use.py`) against this exact battery and found it blocks only 2/7 —
 * it misses a force-push hidden in a compound command, `git reset --hard`,
 * `--no-verify`, a private-SSH-key read, and `curl | sh` (research/hook-pain-points.md).
 * Here we reproduce that bug CLASS with a faithful naive guard, then prove the
 * compiled hook (examples/harness/safe-bash-guard.hook.mjs) blocks all 7 by
 * construction — the matching is AST-backed and the protocol is emitted, so the
 * blind spots and the false-confidence bug class simply can't occur.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

import {
  DISASTER_CATALOG,
  verifyGuardrail,
  unblockedDisasters,
  assertBlocksDisasters,
  experimental_alternateSpellings,
  type DisasterEvent,
  type DisasterCategory,
} from "./guardrail-check.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const COMPILED_GUARD = resolve(
  REPO_ROOT,
  "examples",
  "harness",
  "safe-bash-guard.hook.mjs",
);

// The hand-written shape: a literal-substring blocklist (what a copier writes,
// and what the real disler hook does in Python). Correctly coded (exit 2) — the
// bug is SCOPE, not the protocol: it only sees the exact strings it lists.
const NAIVE_GUARD = `#!/usr/bin/env bash
input=$(cat)
case "$input" in
  *"git push --force"*) echo "blocked: force push" >&2; exit 2 ;;
  *"rm -rf /"*) echo "blocked: rm -rf" >&2; exit 2 ;;
esac
exit 0
`;

test("a hand-written substring guard has the documented blind spots (the bug class)", () => {
  const dir = makeTmpDir();
  try {
    const guard = resolve(dir, "naive-guard.sh");
    writeFileSync(guard, NAIVE_GUARD);
    chmodSync(guard, 0o755);

    const results = verifyGuardrail(`bash ${guard}`);
    const missed = unblockedDisasters(results).map((m) => m.event.id);

    // It catches the two literal strings it lists …
    assert.ok(!missed.includes("force-push"), "blocks literal --force");
    assert.ok(!missed.includes("rm-rf"), "blocks literal rm -rf /");
    // … and silently misses everything else — exactly the false-confidence gap.
    for (const id of [
      "force-push-compound",
      "reset-hard",
      "no-verify-commit",
      "read-ssh-key",
      "curl-pipe-sh",
    ]) {
      assert.ok(missed.includes(id), `naive guard misses ${id}`);
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the COMPILED hook blocks all 7 disasters by construction (closes the gaps)", () => {
  // cwd = repo root so the example's `../../dist/hook.js` import resolves.
  // No throw ⇒ every disaster in the battery is denied (exit 2).
  assertBlocksDisasters(
    `node ${CLI} hook-runtime run-program ${COMPILED_GUARD}`,
    {
      cwd: REPO_ROOT,
    },
  );
});

// ---------------------------------------------------------------------------
// #174 — a guard that halts the turn instead of denying the call
// ---------------------------------------------------------------------------

/**
 * The SAME coverage as a correct exit-2 guard, expressed through the other
 * documented mechanism: `{"continue": false}` stops the whole turn and hands
 * `stopReason` back to the agent as text. Authors reach for it when they want to
 * explain the refusal rather than just refuse.
 *
 * Reported by a vigiles adopter (#174) on a real `github-helper` write-guard.
 * Until 2026-08-31 `verifyGuardrail` read only exit 2 / `decision` /
 * `permissionDecision`, so this guard — which stops every disaster in the
 * battery — was reported as blocking NONE of them, and `assertBlocksDisasters`
 * failed the build over a working guard. The tool whose stated job is catching
 * "a guard that looks fine and silently does nothing" said exactly that about a
 * guard that does not.
 */
const HALTING_GUARD = `#!/usr/bin/env bash
cat > /dev/null
printf '%s' '{"continue": false, "stopReason": "blocked by policy"}'
exit 0
`;

/** The same shape, but permissive — the control that keeps the test honest. */
const HALTING_GUARD_NOOP = `#!/usr/bin/env bash
cat > /dev/null
printf '%s' '{"continue": true}'
exit 0
`;

test("a guard that halts the turn is credited with blocking (#174)", () => {
  const dir = makeTmpDir();
  try {
    const guard = resolve(dir, "halting-guard.sh");
    writeFileSync(guard, HALTING_GUARD);
    chmodSync(guard, 0o755);

    const results = verifyGuardrail(`bash ${guard}`);
    const missed = unblockedDisasters(results).map((m) => m.event.id);

    assert.deepEqual(
      missed,
      [],
      "a guard halting the turn prevents every disaster; reporting misses here is the #174 inversion",
    );
    // Every result exits 0 — so the verdict cannot be coming from the exit code.
    assert.ok(
      results.every((r) => r.exitCode === 0),
      "the guard blocks by field, not by exit code",
    );
    // The gate itself must now pass on it.
    assert.doesNotThrow(() => {
      assertBlocksDisasters(`bash ${guard}`);
    });
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that only says continue:true still fails the battery", () => {
  // The other half: the widened verdict must not credit a hook that permits.
  // Without this, "blocked" could be satisfied by the mere PRESENCE of a
  // `continue` key, which is the bug with the sign flipped.
  const dir = makeTmpDir();
  try {
    const guard = resolve(dir, "noop-guard.sh");
    writeFileSync(guard, HALTING_GUARD_NOOP);
    chmodSync(guard, 0o755);

    assert.throws(
      () => {
        assertBlocksDisasters(`bash ${guard}`);
      },
      /did NOT block/,
      "a permissive guard must still be reported as false confidence",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// The same seed, rewritten so the SHELL sees the same thing (2026-09-02)
// ---------------------------------------------------------------------------
/**
 * The 7/7 headline was measured on the seven seeds AS WRITTEN, and three ordinary
 * rewrites walked past the guard: `git push "--force" …`, `sudo git push --force …`,
 * `/usr/bin/git push --force …` all exited 0 while the plain form exited 2.
 *
 * The cases are GENERATED, not listed. An earlier version of this block listed
 * nine rewrites by hand and passed — then `experimental_alternateSpellings` produced 73 and
 * one of them, `git commit -n -m …`, still got through: the guard asks for the
 * literal `--no-verify` and `-n` is a different string. Nine hand-written rows
 * are the same bounded set that produced the original gap, which is the whole
 * argument for generating them.
 *
 * Nothing new is judged: `dangerous` is inherited from the catalog seed a human
 * labelled, `same command` is decided by the normalizer, and a rewrite failing
 * that check throws inside the generator rather than reaching this test.
 */
// COST, stated because it grows with every family: each spelling spawns the
// real CLI once, so this is O(spellings) process launches — measured 85s for
// 143 events (7 seeds + 136 rewrites) against the default 60s limit. Raise the
// timeout deliberately; if it ever needs raising again, that is the signal to
// batch the runs rather than to keep buying time.
test("every shell-equivalent rewrite of the battery is still blocked", () => {
  const events = experimental_alternateSpellings(DISASTER_CATALOG);
  assert.ok(
    events.length > 30,
    `expected a real corpus, got ${String(events.length)}`,
  );
  const missed = unblockedDisasters(
    verifyGuardrail(`node ${CLI} hook-runtime run-program ${COMPILED_GUARD}`, {
      cwd: REPO_ROOT,
      events,
    }),
  ).map((m) => String(m.event.input["command"]));
  assert.deepEqual(
    missed,
    [],
    "a rewrite the shell reads identically must not change the verdict",
  );
}, 240_000);

test("g\\it push --force is blocked (a spelling the battery could not have found)", () => {
  // `sh -c 'g\it --version'` runs git: a backslash before an ordinary character is
  // that character. mvdan-sh keeps it, the normalizer used to keep it too, and the
  // guard behind the 7/7 let `g\it push --force origin main` through. The battery
  // shares that normalizer, so it could not emit this spelling until the
  // normalizer learned it — a reader found it, not the generator. Pinned here so
  // it cannot come back, and the generator now emits it (family "escaped
  // character in head").
  const seed = DISASTER_CATALOG.find((e) => e.id === "force-push");
  assert.ok(seed, "the catalog names a force-push seed");
  const missed = unblockedDisasters(
    verifyGuardrail(`node ${CLI} hook-runtime run-program ${COMPILED_GUARD}`, {
      cwd: REPO_ROOT,
      events: [
        {
          ...seed,
          id: "force-push~escaped-head",
          input: { command: "g\\it push --force origin main" },
        },
      ],
    }),
  );
  assert.deepEqual(missed, []);
});

test("the guard did not become a blunt blocker", () => {
  // PRECISION. Over-blocking is what gets a guard switched off. These are the
  // commands a developer types all day; if the matcher starts denying them the
  // battery number above is worthless.
  const benign: DisasterEvent[] = [
    "git push origin main",
    "git commit -m fix",
    "git reset --soft HEAD~1",
    "echo git push --force",
    "cat README.md",
  ].map((command, i) => ({
    id: `benign-${String(i)}`,
    label: command,
    category: "destructive-git" as DisasterCategory,
    tool: "Bash",
    input: { command },
  }));
  const blocked = verifyGuardrail(
    `node ${CLI} hook-runtime run-program ${COMPILED_GUARD}`,
    { cwd: REPO_ROOT, events: benign },
  )
    .filter((r) => r.blocked)
    .map((r) => r.event.label);
  assert.deepEqual(blocked, [], "a benign command must still pass");
});
