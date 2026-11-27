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
import { test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

import {
  DISASTER_CATALOG,
  disasters,
  runGuardrail,
  guardrail,
  unblockedDisasters,
  type DisasterEvent,
  type DisasterCategory,
} from "./guardrail-check.js";
import { assertChecks } from "./check.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { runHook } from "./run-hook.js";
import { experimental_loadHook as loadHook } from "./load-hook.js";
import type { AnyHook } from "./core/hook-program.js";

// Built once: each `disasters()` call generates and proves every spelling (~1.5 s).
const ALL = disasters();

// The shipped guard's secret rule is `touches(["~/.ssh", …])`, a MENTION
// matcher by design (an over-inclusive denylist), so it also blocks
// `echo 'cat ~/.ssh/id_rsa'`. Its look-alikes are left out; every other one
// must pass.
const SAFE_GUARD_SET = {
  ...ALL,
  harmless: ALL.harmless.filter((t) => t.of !== "read-ssh-key"),
};

/** The seven seeds alone: enough for a test that asserts on seed ids. */
const SEEDS = { ...ALL, spellings: [], harmless: [] };

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const COMPILED_GUARD = resolve(
  REPO_ROOT,
  "examples",
  "harness",
  "safe-bash-guard.hook.mjs",
);
/** The guard as the hook config wires it: the shipped runtime, one process per case. */
const WIRED = `node ${CLI} hook-runtime run-program ${COMPILED_GUARD}`;

// The guard as a hook object, loaded by the same loader the runtime uses, so a
// battery decides it in this process instead of one CLI launch per case.
let guard: AnyHook;
beforeAll(async () => {
  guard = await loadHook(COMPILED_GUARD);
});

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

    const results = runGuardrail(`bash ${guard}`, SEEDS).rows;
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

// The battery carries every generated spelling of each disaster, so it decides
// the guard in-process: spawning the CLI per case cost ~175 launches (26 s).
// The test after it keeps the wired runtime honest on a sample of the same rows.
test("the COMPILED hook blocks all 7 disasters by construction (closes the gaps)", () => {
  // No throw ⇒ every disaster AND every spelling of it is denied.
  assertChecks(runGuardrail(guard, SAFE_GUARD_SET, { cwd: REPO_ROOT }), [
    guardrail(),
  ]);
});

/** The seeds plus every `step`-th row after them: a spread over the spellings. */
function sample<T>(rows: readonly T[], step: number): readonly T[] {
  return rows.filter((_, i) => i < 7 || i % step === 0);
}

test("the wired runtime decides a sample of the battery exactly as the hook does in-process", () => {
  // The batteries decide in-process; the shipped path adds the JSON stdin
  // round-trip, the runtime's lazy module graph, root resolution and the exit
  // code. Any of those drifting would leave the in-process verdicts green, so
  // the same rows go through both and must agree field by field.
  const set = {
    ...SAFE_GUARD_SET,
    events: sample([...ALL.events, ...ALL.spellings], 12),
    spellings: [],
    harmless: sample(SAFE_GUARD_SET.harmless, 6),
  };
  const verdicts = (hook: string | AnyHook) =>
    runGuardrail(hook, set, { cwd: REPO_ROOT }).rows.map((r) => ({
      blocked: r.blocked,
      exitCode: r.exitCode,
      run: r.run,
    }));
  const inProcess = verdicts(guard);
  // Guards: the sample holds both verdicts, so "agree" cannot mean "all allow".
  assert.ok(inProcess.some((v) => v.blocked));
  assert.ok(inProcess.some((v) => !v.blocked));
  // Guards: the shipped runtime and decide() give the same verdict per row.
  assert.deepEqual(verdicts(WIRED), inProcess);
}, 60_000);

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
 * battery — was reported as blocking NONE of them, and `assertGuardrail`
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

    const run = runGuardrail(`bash ${guard}`, SEEDS);
    const results = run.rows;
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
      assertChecks(run, [guardrail()]);
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
        assertChecks(runGuardrail(`bash ${guard}`, SEEDS), [guardrail()]);
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
// Decided in-process, as the battery above: spawned, this was one CLI launch per
// spelling (85 s for 143 events). The sample test keeps the wired path in check.
test("every shell-equivalent rewrite of the battery is still blocked", () => {
  const events = ALL.spellings;
  assert.ok(
    events.length > 30,
    `expected a real corpus, got ${String(events.length)}`,
  );
  const missed = unblockedDisasters(
    runGuardrail(
      guard,
      { ...SEEDS, events /* these events ARE spellings already */ },
      { cwd: REPO_ROOT },
    ).rows,
  ).map((m) => String(m.event.input["command"]));
  assert.deepEqual(
    missed,
    [],
    "a rewrite the shell reads identically must not change the verdict",
  );
});

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
    runGuardrail(
      WIRED,
      disasters({
        events: [
          {
            ...seed,
            id: "force-push~escaped-head",
            input: { command: "g\\it push --force origin main" },
          },
        ],
        harmless: [],
        spellings: [] /* these events ARE spellings already */,
      }),
      { cwd: REPO_ROOT },
    ).rows,
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
  const blocked = runGuardrail(
    WIRED,
    disasters({ events: benign, harmless: [], spellings: [] }),
    { cwd: REPO_ROOT },
  )
    .rows.filter((r) => r.blocked)
    .map((r) => r.event.label);
  assert.deepEqual(blocked, [], "a benign command must still pass");
});

// Codex on #508: the shipped guard missed `git -C "$PWD" commit -n` once the
// short-flag table became per command. It blocks or asks on every spelling
// whose subcommand slot holds a dynamic word.
test("the compiled hook does not allow a --no-verify commit behind a dynamic word", () => {
  for (const [command, want] of [
    ['git -C "$PWD" commit -n -m x', "block"],
    ['git -c "$K=$V" commit -n -m x', "block"],
    ["git $OPTS commit -n -m x", "ask"],
    ['git "$SUB" -n -m x', "ask"],
  ] as const) {
    const r = runHook(
      WIRED,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      },
      { cwd: REPO_ROOT },
    );
    if (want === "block") assert.equal(r.blocked, true, command);
    else assert.equal(r.decision, "ask", command);
  }
}, 60_000);
