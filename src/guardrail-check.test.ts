/**
 * Guardrail-verification test suite (vitest) — the committed "false confidence"
 * receipt. Two byte-identical-looking force-push guards differ only in exit code;
 * the engine must tell them apart (exit 1 = silently allows, exit 2 = blocks).
 * Real shell hooks via runHook; no model, no jq dependency (greps the event JSON).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DISASTER_CATALOG,
  verifyGuardrail,
  unblockedDisasters,
  assertBlocksDisasters,
  formatGuardrailReport,
  CONTROL_CASE,
  type CaseOutcome,
} from "./guardrail-check.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** A push-guard that blocks `git push` with the given exit code. */
function writeGuard(dir: string, name: string, exitCode: number): string {
  const body = `#!/usr/bin/env bash
INPUT=$(cat)
if echo "$INPUT" | grep -q 'git push'; then
  echo "BLOCKED: no direct pushes" >&2
  exit ${exitCode}
fi
exit 0
`;
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return `bash ${path}`;
}

const PUSH_EVENTS = DISASTER_CATALOG.filter((e) =>
  e.id.startsWith("force-push"),
);

test("exit 2 guard BLOCKS the force-push battery; exit 1 guard silently allows it", () => {
  const dir = makeTmpDir("guardrail-receipt");
  try {
    const real = writeGuard(dir, "real-guard.sh", 2);
    const fake = writeGuard(dir, "fake-guard.sh", 1);

    const realResults = verifyGuardrail(real, { events: PUSH_EVENTS });
    assert.ok(
      realResults.every((r) => r.blocked),
      "exit 2 should block every push",
    );

    const fakeResults = verifyGuardrail(fake, { events: PUSH_EVENTS });
    assert.ok(
      fakeResults.every((r) => !r.blocked),
      "exit 1 looks like a block but allows — the false-confidence bug",
    );
    assert.equal(fakeResults[0].exitCode, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("assertBlocksDisasters passes the real guard, throws on the fake with the misses", () => {
  const dir = makeTmpDir("guardrail-assert");
  try {
    const real = writeGuard(dir, "real-guard.sh", 2);
    const fake = writeGuard(dir, "fake-guard.sh", 1);

    // Real guard over the push subset → no throw.
    assert.doesNotThrow(() => {
      assertBlocksDisasters(real, { events: PUSH_EVENTS });
    });

    // Fake guard → throws, naming the missed actions.
    assert.throws(() => {
      assertBlocksDisasters(fake, { events: PUSH_EVENTS });
    }, /did NOT block/);
    assert.throws(() => {
      assertBlocksDisasters(fake, { events: PUSH_EVENTS });
    }, /false confidence/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that only handles git misses the rm -rf / secret-read battery", () => {
  const dir = makeTmpDir("guardrail-partial");
  try {
    const gitOnly = writeGuard(dir, "git-only.sh", 2);
    const results = verifyGuardrail(gitOnly); // full catalog
    const misses = unblockedDisasters(results);
    // It blocks the git pushes but not rm -rf, no-verify, ssh-read, curl|sh.
    const missedIds = misses.map((m) => m.event.id);
    assert.ok(missedIds.includes("rm-rf"));
    assert.ok(missedIds.includes("read-ssh-key"));
    assert.ok(missedIds.includes("curl-pipe-sh"));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("category filter restricts the battery", () => {
  const dir = makeTmpDir("guardrail-cat");
  try {
    const guard = writeGuard(dir, "g.sh", 2);
    const results = verifyGuardrail(guard, { categories: ["destructive-fs"] });
    assert.ok(results.every((r) => r.event.category === "destructive-fs"));
    assert.ok(results.length >= 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("formatGuardrailReport is NEUTRAL — reports allows without judging intent", () => {
  const dir = makeTmpDir("guardrail-fmt");
  try {
    const fake = writeGuard(dir, "fake.sh", 1);
    const report = formatGuardrailReport(
      fake,
      verifyGuardrail(fake, { events: PUSH_EVENTS }),
    );
    assert.match(report, /allows/);
    assert.match(report, /blocks 0\/2/);
    // The coverage map must NOT call an allow "false confidence" — intent unknown.
    assert.doesNotMatch(report, /false confidence/);
    // It points the user at the intent-declaring gate instead.
    assert.match(report, /assertBlocksDisasters/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the catalog is well-formed: unique ids, every entry has a command", () => {
  const ids = new Set(DISASTER_CATALOG.map((e) => e.id));
  assert.equal(ids.size, DISASTER_CATALOG.length);
  for (const e of DISASTER_CATALOG) {
    assert.equal(typeof e.input.command, "string");
    assert.ok((e.input.command as string).length > 0);
  }
});

// ---------------------------------------------------------------------------
// The control probe (#213). Exit 2 is the DENY code, and it is also what an
// interpreter returns when it cannot open its script — so "blocked" alone never
// proves the guard ran. One command no guard has a reason to deny runs first;
// if it is blocked too, no block in the battery is evidence.
// ---------------------------------------------------------------------------

/** The outcome as one comparable tag, so a test names the decision, not a sentence. */
function tag(o: CaseOutcome): string {
  return o.kind === "not-run" ? `not-run/${o.why}` : o.kind;
}

/** Denies every Bash call it is handed. */
const DENY_ALL = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'`;

/** Denies everything except the default control's command. */
const DENY_BUT_LS = `case "$(cat)" in *'"command":"ls"'*) exit 0;; esac; exit 2`;

/**
 * Every spelling of "run a script that is not there" the old preflight missed or
 * caught — the control has to catch all of them without reading the command.
 */
const MISSING_SCRIPT = [
  'GUARD=missing.py; python3 "$GUARD"',
  "cd hooks && python3 g.py",
  "r=$(python3 missing.py)",
  "python3 -E missing.py",
  "env python3 missing.py",
  "python3 missing.py",
];

test("a guard whose script is missing has NO VERDICT, in every spelling", () => {
  const dir = makeTmpDir("guardrail-control-missing");
  try {
    mkdirSync(join(dir, "hooks"));
    for (const cmd of MISSING_SCRIPT) {
      const results = verifyGuardrail(cmd, { cwd: dir });
      assert.ok(results.length > 0, cmd);
      for (const r of results)
        assert.equal(tag(r.outcome), "not-run/control-blocked", cmd);
      assert.throws(() => {
        assertBlocksDisasters(cmd, { cwd: dir });
      }, cmd);
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that denies everything has no verdict either", () => {
  const results = verifyGuardrail(DENY_ALL);
  for (const r of results) {
    assert.equal(tag(r.outcome), "not-run/control-blocked");
    // The old fields follow the tag: nothing here was a block.
    assert.equal(r.blocked, false);
    assert.equal(r.ran, false);
  }
  // A report of a battery without a verdict carries no score.
  assert.doesNotMatch(formatGuardrailReport(DENY_ALL, results), /\d+\/\d+/);
});

test("a guard that denies only the dangerous commands keeps its verdict", () => {
  const results = verifyGuardrail(DENY_BUT_LS);
  assert.ok(results.length > 0);
  for (const r of results) assert.equal(tag(r.outcome), "blocked", r.event.id);
  assert.doesNotThrow(() => {
    assertBlocksDisasters(DENY_BUT_LS);
  });
});

test("a decision on stdout beats exit 127 for the control too", () => {
  // `echo deny; ./missing` really decided, then exited 127. The control is
  // therefore BLOCKED (the decision wins), not never-launched — so the battery
  // has no verdict, and the control's own exit code is carried with it.
  const cmd = `${DENY_ALL}; ./definitely-missing-xyz`;
  for (const r of verifyGuardrail(cmd)) {
    if (r.outcome.kind !== "not-run" || r.outcome.why !== "control-blocked")
      throw new Error(`expected control-blocked, got ${tag(r.outcome)}`);
    assert.equal(r.outcome.controlExitCode, 127);
  }
});

test("an allowlist guard gets its verdict back from a control it allows", () => {
  const allowlist = `case "$(cat)" in *'"command":"npm test"'*) exit 0;; esac; exit 2`;
  const control = {
    ...CONTROL_CASE,
    label: "npm test",
    input: { command: "npm test" },
  };
  for (const r of verifyGuardrail(allowlist))
    assert.equal(tag(r.outcome), "not-run/control-blocked");
  for (const r of verifyGuardrail(allowlist, { control }))
    assert.equal(tag(r.outcome), "blocked");
});

test("a program the shell never launched is tagged never-launched", () => {
  for (const r of verifyGuardrail("definitely-not-a-command-xyz")) {
    if (r.outcome.kind !== "not-run" || r.outcome.why !== "never-launched")
      throw new Error(`expected never-launched, got ${tag(r.outcome)}`);
    assert.equal(r.outcome.exitCode, 127);
  }
});

test("every event carries `cwd`, the directory the hook runs in", () => {
  const dir = makeTmpDir("guardrail-cwd");
  try {
    const log = join(dir, "events.jsonl");
    verifyGuardrail(
      `cat >> ${JSON.stringify(log)}; echo >> ${JSON.stringify(log)}`,
      {
        cwd: dir,
      },
    );
    const events = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { cwd?: unknown; tool_input?: unknown });
    assert.ok(events.length > 0);
    for (const e of events) assert.equal(e.cwd, dir);
    // The control is one of them, delivered like any other event.
    assert.ok(
      events.some(
        (e) =>
          JSON.stringify(e.tool_input) === JSON.stringify(CONTROL_CASE.input),
      ),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
