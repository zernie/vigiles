/**
 * Guardrail-verification test suite (vitest) — the committed "false confidence"
 * receipt. Two byte-identical-looking force-push guards differ only in exit code;
 * the engine must tell them apart (exit 1 = silently allows, exit 2 = blocks).
 * Real shell hooks via runHook; no model, no jq dependency (greps the event JSON).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { spawnSync } from "node:child_process";

import {
  DISASTER_CATALOG,
  verifyGuardrail,
  unblockedDisasters,
  assertGuardrail,
  assertBlocksDisasters,
  formatGuardrailReport,
} from "./guardrail-check.js";
import {
  allow,
  deny,
  experimental_defineHook,
  experimental_defineInject,
  inject,
} from "./core/hook-program.js";
import { ADAPTERS } from "./adapter-registry.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** Whether `python3` runs here (the #213 spellings need a real interpreter). */
function hasPython(): boolean {
  return spawnSync("python3", ["--version"]).status === 0;
}

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

    const realResults = verifyGuardrail(real, {
      events: PUSH_EVENTS,
      harmless: [],
    });
    assert.ok(
      realResults.every((r) => r.blocked),
      "exit 2 should block every push",
    );

    const fakeResults = verifyGuardrail(fake, {
      events: PUSH_EVENTS,
      harmless: [],
    });
    assert.ok(
      fakeResults.every((r) => !r.blocked),
      "exit 1 looks like a block but allows — the false-confidence bug",
    );
    assert.equal(fakeResults[0].exitCode, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("assertGuardrail passes the real guard, throws on the fake with the misses", () => {
  const dir = makeTmpDir("guardrail-assert");
  try {
    const real = writeGuard(dir, "real-guard.sh", 2);
    const fake = writeGuard(dir, "fake-guard.sh", 1);

    // Real guard over the push subset → no throw.
    assert.doesNotThrow(() => {
      assertGuardrail(real, { events: PUSH_EVENTS, harmless: [] });
    });

    // Fake guard → throws, naming the missed actions.
    assert.throws(() => {
      assertGuardrail(fake, { events: PUSH_EVENTS, harmless: [] });
    }, /did NOT block/);
    assert.throws(() => {
      assertGuardrail(fake, { events: PUSH_EVENTS, harmless: [] });
    }, /false confidence/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that only handles git misses the rm -rf / secret-read battery", () => {
  const dir = makeTmpDir("guardrail-partial");
  try {
    const gitOnly = writeGuard(dir, "git-only.sh", 2);
    const results = verifyGuardrail(gitOnly, { harmless: [] }); // full catalog
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
    const results = verifyGuardrail(guard, {
      categories: ["destructive-fs"],
      harmless: [],
    });
    assert.ok(
      results.every(
        (r) => r.expect === "block" && r.event.category === "destructive-fs",
      ),
    );
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
      verifyGuardrail(fake, { events: PUSH_EVENTS, harmless: [] }),
    );
    assert.match(report, /allows/);
    assert.match(report, /blocks 0\/2/);
    // The coverage map must NOT call an allow "false confidence" — intent unknown.
    assert.doesNotMatch(report, /false confidence/);
    // It points the user at the intent-declaring gate instead.
    assert.match(report, /assertGuardrail/);
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
// A compiled hook OBJECT is checked exactly, by calling its decision (#418)
// ---------------------------------------------------------------------------

/**
 * The compiled equivalent of a real reporter's force-push guard (#418): a bare
 * `--force`/`-f` push is denied, every other command allowed. Decided on the
 * parsed command, so it blocks exactly the two force-push seeds of the catalog.
 */
const PUSH_FORCE_GUARD = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true })
      ? deny("bare --force push is banned")
      : allow(),
});

test("a compiled hook object is decided in-process: one decide() call per case, no exit code to read", () => {
  let calls = 0;
  const counting = experimental_defineHook({
    on: "PreToolUse",
    decide: (e) => {
      calls += 1;
      return PUSH_FORCE_GUARD.decide(e);
    },
  });
  const results = verifyGuardrail(counting, { harmless: [] });
  assert.equal(calls, results.length);
  assert.ok(results.every((r) => r.run === "ran"));
  assert.deepEqual(
    results.filter((r) => r.blocked).map((r) => r.event.id),
    ["force-push", "force-push-compound"],
  );
});

test("assertGuardrail on a compiled hook: passes when it blocks the selection, throws on a miss", () => {
  const pushes = { events: PUSH_EVENTS, harmless: [] };
  assert.doesNotThrow(() => {
    assertGuardrail(PUSH_FORCE_GUARD, pushes);
  });
  assert.throws(() => {
    assertGuardrail(PUSH_FORCE_GUARD, { harmless: [] });
  });
});

test("an observe-mode compiled gate blocks nothing: the battery reads the action, not the raw decision", () => {
  const shadow = experimental_defineHook({
    on: "PreToolUse",
    mode: "observe",
    decide: PUSH_FORCE_GUARD.decide,
  });
  const results = verifyGuardrail(shadow, {
    events: PUSH_EVENTS,
    harmless: [],
  });
  assert.ok(results.every((r) => r.run === "ran" && !r.blocked));
});

test("a compiled hook that is not a gate is refused, not scored", () => {
  const nudge = experimental_defineInject({
    on: "SessionStart",
    produce: () => inject("hello"),
  });
  assert.throws(() => verifyGuardrail(nudge), TypeError);
});

test("assertBlocksDisasters is the deprecated alias of assertGuardrail", () => {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the alias under test
  assert.equal(assertBlocksDisasters, assertGuardrail);
});

// ---------------------------------------------------------------------------
// A string hook that crashed on every call NEVER RAN (#213, #418)
// ---------------------------------------------------------------------------

/** A guard that sources a helper library first — run without the library. */
function writeLibGuard(dir: string): string {
  const path = join(dir, "lib-guard.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
input=$(cat)
case "$input" in *"git push"*) echo "blocked" >&2; exit 2 ;; esac
exit 0
`,
  );
  chmodSync(path, 0o755);
  return `bash ${path}`;
}

test("a guard whose library is missing (exit 1 on every call) never ran, on every harness's protocol", () => {
  const dir = makeTmpDir("guardrail-crash");
  try {
    const guard = writeLibGuard(dir);
    for (const adapter of ADAPTERS) {
      const results = verifyGuardrail(guard, {
        protocol: adapter.hookProtocol,
      });
      assert.ok(results.length > DISASTER_CATALOG.length);
      for (const r of results) {
        assert.equal(r.run, "crashed", `${adapter.name}: ${r.event.id}`);
        assert.equal(r.ran, false);
        assert.equal(r.blocked, false);
      }
      assert.throws(() => {
        assertGuardrail(guard, { protocol: adapter.hookProtocol });
      });
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

// The #213 spellings of "the interpreter cannot open its script". Python exits
// 2 — the DENY code — so each of these used to score a perfect 7/7.
test.skipIf(!hasPython())(
  "an interpreter that cannot open its script (exit 2 on every call) never ran — every #213 spelling",
  () => {
    const dir = makeTmpDir("guardrail-213");
    try {
      const missing = join(dir, "missing.py");
      for (const command of [
        `python3 ${missing}`,
        `GUARD=${missing}; python3 "$GUARD"`,
        `cd ${dir} && python3 missing.py`,
        `r=$(python3 ${missing})`,
        `python3 -E ${missing}`,
        `env python3 ${missing}`,
      ]) {
        const results = verifyGuardrail(command, { harmless: [] });
        assert.ok(
          results.every((r) => r.run === "crashed" && !r.blocked),
          command,
        );
      }
    } finally {
      cleanupTmpDir(dir);
    }
  },
);

test("a real exit-2 guard with an ordinary message is NOT a crash", () => {
  const dir = makeTmpDir("guardrail-real");
  try {
    const real = writeGuard(dir, "real.sh", 2);
    const results = verifyGuardrail(real, {
      events: PUSH_EVENTS,
      harmless: [],
    });
    assert.ok(results.every((r) => r.run === "ran" && r.blocked));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a structured decision wins over a loader error on stderr", () => {
  const dir = makeTmpDir("guardrail-decision");
  try {
    const path = join(dir, "decides.sh");
    writeFileSync(
      path,
      `#!/usr/bin/env bash
echo '{"decision":"block","reason":"no"}'
echo "lib/x.sh: No such file or directory" >&2
exit 1
`,
    );
    const results = verifyGuardrail(`bash ${path}`, {
      events: PUSH_EVENTS,
      harmless: [],
    });
    assert.ok(results.every((r) => r.run === "ran" && r.blocked));
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// The "must allow" half: harmless look-alikes are on by default (#418)
// ---------------------------------------------------------------------------

/** The over-blocking shape from #418: it greps the RAW input for the text. */
function writeTextGuard(dir: string): string {
  const path = join(dir, "text-guard.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
input=$(cat)
echo "$input" | grep -qE 'git push (--force|-f)|rm -rf /|--no-verify|\\.ssh/id_|curl .*\\| *sh|reset --hard' \\
  && { echo "blocked" >&2; exit 2; }
exit 0
`,
  );
  return `bash ${path}`;
}

test("a guard that matches the raw text blocks a look-alike of every form, and assertGuardrail fails it", () => {
  const dir = makeTmpDir("guardrail-text");
  try {
    const guard = writeTextGuard(dir);
    const results = verifyGuardrail(guard);
    assert.deepEqual(unblockedDisasters(results), []);
    const overBlocked = results.filter(
      (r) => r.expect === "allow" && r.blocked,
    );
    const forms = new Set<string>(
      overBlocked.map((r) => (r.expect === "allow" ? r.event.form : "")),
    );
    for (const form of ["commit-message", "heredoc", "echo", "grep-pattern"])
      assert.ok(forms.has(form), form);
    assert.throws(() => {
      assertGuardrail(guard);
    });
    assert.doesNotThrow(() => {
      assertGuardrail(guard, { harmless: [] });
    });
  } finally {
    cleanupTmpDir(dir);
  }
});

/**
 * A guard deciding on the parsed command — `runs()` and `pipesToShell()` only.
 * (The secret read is left out: `touches()` is a MENTION matcher by design, an
 * over-inclusive denylist, so it also blocks `echo 'cat ~/.ssh/id_rsa'`.)
 */
const PARSED_GUARD = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => {
    const c = e.command;
    const banned =
      c.runs("git push", { force: true }) ||
      c.runs("git reset --hard") ||
      c.runs("git commit --no-verify") ||
      c.runs("rm", { force: true }) ||
      c.pipesToShell();
    return banned ? deny("banned") : allow();
  },
});

test("a compiled guard deciding on the parsed command blocks every disaster and no look-alike", () => {
  const events = DISASTER_CATALOG.filter((e) => e.id !== "read-ssh-key");
  const results = verifyGuardrail(PARSED_GUARD, { events });
  assert.ok(results.some((r) => r.expect === "allow"));
  for (const r of results)
    assert.equal(r.blocked, r.expect === "block", r.event.id);
  assert.doesNotThrow(() => {
    assertGuardrail(PARSED_GUARD, { events });
  });
});

test("harmless: [] runs no look-alike; a custom battery gets look-alikes of its own cases", () => {
  const off = verifyGuardrail(PUSH_FORCE_GUARD, { harmless: [] });
  assert.ok(off.every((r) => r.expect === "block"));

  const mine = verifyGuardrail(PUSH_FORCE_GUARD, { events: PUSH_EVENTS });
  const seeds = new Set(PUSH_EVENTS.map((e) => e.id));
  const twins = mine.filter((r) => r.expect === "allow");
  assert.ok(twins.length > 0);
  for (const r of twins)
    assert.ok(r.expect === "allow" && seeds.has(r.event.of ?? ""), r.event.id);
});

test("a custom harmless case is checked as must-allow", () => {
  // A commit message from the #418 report: the reporter's own text guard
  // denied it; a guard on the parsed command lets it through.
  const results = verifyGuardrail(PUSH_FORCE_GUARD, {
    events: PUSH_EVENTS,
    harmless: [
      {
        id: "docs-commit",
        label: "commit whose message quotes a force push",
        form: "custom",
        tool: "Bash",
        input: {
          command: 'git commit -m "docs: never git push --force to main"',
        },
      },
    ],
  });
  const row = results.find((r) => r.event.id === "docs-commit");
  assert.ok(row);
  assert.equal(row.expect, "allow");
  assert.equal(row.blocked, false);
});

// ---------------------------------------------------------------------------
// A gate's declared `needs` come from `ctx`, never from an empty context
// ---------------------------------------------------------------------------

/** The documented `git.branch` guard: no push while on `main`. */
const MAIN_PUSH_GUARD = experimental_defineHook({
  on: "PreToolUse",
  needs: ["git.branch"],
  decide: (e) =>
    e.ctx["git.branch"] === "main" && e.command.runs("git push")
      ? deny("no push from main")
      : allow(),
});

test("a gate with needs decides on the facts passed in ctx", () => {
  const results = verifyGuardrail(MAIN_PUSH_GUARD, {
    events: PUSH_EVENTS,
    harmless: [],
    ctx: { "git.branch": "main" },
  });
  assert.ok(results.every((r) => r.run === "ran" && r.blocked));
});

test("a gate whose needs ctx does not supply is refused, naming the missing fact", () => {
  for (const ctx of [undefined, { "git.isDirty": true }])
    assert.throws(
      () => verifyGuardrail(MAIN_PUSH_GUARD, { events: PUSH_EVENTS, ctx }),
      (e: unknown) =>
        e instanceof TypeError && e.message.includes("git.branch"),
    );
});
