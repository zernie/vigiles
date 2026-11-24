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
  disasters,
  runGuardrail,
  guardrail,
  unblockedDisasters,
  alternateSpellings,
  formatGuardrailReport,
  spellingCases,
} from "./guardrail-check.js";
import { assertChecks } from "./check.js";
import {
  allow,
  deny,
  experimental_defineHook,
  experimental_defineInject,
  experimental_definePromptGate,
  experimental_defineStopGate,
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

    const realResults = runGuardrail(
      real,
      disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
    ).rows;
    assert.ok(
      realResults.every((r) => r.blocked),
      "exit 2 should block every push",
    );

    const fakeResults = runGuardrail(
      fake,
      disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
    ).rows;
    assert.ok(
      fakeResults.every((r) => !r.blocked),
      "exit 1 looks like a block but allows — the false-confidence bug",
    );
    assert.equal(fakeResults[0].exitCode, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("guardrail passes the real guard, throws on the fake with the misses", () => {
  const dir = makeTmpDir("guardrail-assert");
  try {
    const real = writeGuard(dir, "real-guard.sh", 2);
    const fake = writeGuard(dir, "fake-guard.sh", 1);

    // Real guard over the push subset → no throw.
    assert.doesNotThrow(() => {
      assertChecks(
        runGuardrail(
          real,
          disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
        ),
        [guardrail()],
      );
    });

    // Fake guard → throws, naming the missed actions.
    assert.throws(() => {
      assertChecks(
        runGuardrail(
          fake,
          disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
        ),
        [guardrail()],
      );
    }, /did NOT block/);
    assert.throws(() => {
      assertChecks(
        runGuardrail(
          fake,
          disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
        ),
        [guardrail()],
      );
    }, /false confidence/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that only handles git misses the rm -rf / secret-read battery", () => {
  const dir = makeTmpDir("guardrail-partial");
  try {
    const gitOnly = writeGuard(dir, "git-only.sh", 2);
    const results = runGuardrail(
      gitOnly,
      disasters({ harmless: [], spellings: [] }),
    ).rows; // full catalog
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
    const results = runGuardrail(
      guard,
      disasters({
        categories: ["destructive-fs"],
        harmless: [],
        spellings: [],
      }),
    ).rows;
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
      runGuardrail(
        fake,
        disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
      ).rows,
    );
    assert.match(report, /allows/);
    assert.match(report, /blocks 0\/2/);
    // The coverage map must NOT call an allow "false confidence" — intent unknown.
    assert.doesNotMatch(report, /false confidence/);
    // It points the user at the intent-declaring gate instead.
    assert.match(report, /disasters\(\{ categories/);
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
  const results = runGuardrail(
    counting,
    disasters({ harmless: [], spellings: [] }),
  ).rows;
  assert.equal(calls, results.length);
  assert.ok(results.every((r) => r.run === "ran"));
  assert.deepEqual(
    results.filter((r) => r.blocked).map((r) => r.event.id),
    ["force-push", "force-push-compound"],
  );
});

test("guardrail on a compiled hook: passes when it blocks the selection, throws on a miss", () => {
  const pushes = disasters({
    events: PUSH_EVENTS,
    harmless: [],
    spellings: [],
  });
  assert.doesNotThrow(() => {
    assertChecks(runGuardrail(PUSH_FORCE_GUARD, pushes), [guardrail()]);
  });
  assert.throws(() => {
    assertChecks(
      runGuardrail(
        PUSH_FORCE_GUARD,
        disasters({ harmless: [], spellings: [] }),
      ),
      [guardrail()],
    );
  });
});

test("an observe-mode compiled gate blocks nothing: the battery reads the action, not the raw decision", () => {
  const shadow = experimental_defineHook({
    on: "PreToolUse",
    mode: "observe",
    decide: PUSH_FORCE_GUARD.decide,
  });
  const results = runGuardrail(
    shadow,
    disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
  ).rows;
  assert.ok(results.every((r) => r.run === "ran" && !r.blocked));
});

test("a compiled hook that is not a gate is refused, not scored", () => {
  const nudge = experimental_defineInject({
    on: "SessionStart",
    produce: () => inject("hello"),
  });
  assert.throws(() => runGuardrail(nudge).rows, TypeError);
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
      const results = runGuardrail(guard, disasters({ spellings: [] }), {
        protocol: adapter.hookProtocol,
      }).rows;
      assert.ok(results.length > DISASTER_CATALOG.length);
      for (const r of results) {
        assert.equal(r.run, "crashed", `${adapter.name}: ${r.event.id}`);
        assert.equal(r.ran, false);
        assert.equal(r.blocked, false);
      }
      assert.throws(() => {
        assertChecks(
          runGuardrail(guard, disasters({ spellings: [] }), {
            protocol: adapter.hookProtocol,
          }),
          [guardrail()],
        );
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
        // With the look-alikes on: they fail too, so exit 2 cannot be a policy.
        const results = runGuardrail(
          command,
          disasters({ spellings: [] }),
        ).rows;
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
    const results = runGuardrail(
      real,
      disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
    ).rows;
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
    const results = runGuardrail(
      `bash ${path}`,
      disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
    ).rows;
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

test("a guard that matches the raw text blocks a look-alike of every form, and guardrail fails it", () => {
  const dir = makeTmpDir("guardrail-text");
  try {
    const guard = writeTextGuard(dir);
    const results = runGuardrail(guard, disasters({ spellings: [] })).rows;
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
      assertChecks(runGuardrail(guard, disasters({ spellings: [] })), [
        guardrail(),
      ]);
    });
    assert.doesNotThrow(() => {
      assertChecks(
        runGuardrail(guard, disasters({ harmless: [], spellings: [] })),
        [guardrail()],
      );
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
  const results = runGuardrail(PARSED_GUARD, disasters({ events })).rows;
  assert.ok(results.some((r) => r.expect === "allow"));
  for (const r of results)
    assert.equal(r.blocked, r.expect === "block", r.event.id);
  assert.doesNotThrow(() => {
    assertChecks(runGuardrail(PARSED_GUARD, disasters({ events })), [
      guardrail(),
    ]);
  });
});

test("harmless: [] runs no look-alike; a custom battery gets look-alikes of its own cases", () => {
  const off = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({ harmless: [], spellings: [] }),
  ).rows;
  assert.ok(off.every((r) => r.expect === "block"));

  const mine = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({ events: PUSH_EVENTS }),
  ).rows;
  const seeds = new Set(PUSH_EVENTS.map((e) => e.id));
  const twins = mine.filter((r) => r.expect === "allow");
  assert.ok(twins.length > 0);
  for (const r of twins)
    assert.ok(r.expect === "allow" && seeds.has(r.event.of ?? ""), r.event.id);
});

test("a custom harmless case is checked as must-allow", () => {
  // A commit message from the #418 report: the reporter's own text guard
  // denied it; a guard on the parsed command lets it through.
  const results = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({
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
    }),
  ).rows;
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
  const results = runGuardrail(
    MAIN_PUSH_GUARD,
    disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] }),
    { ctx: { "git.branch": "main" } },
  ).rows;
  assert.ok(results.every((r) => r.run === "ran" && r.blocked));
});

test("a gate whose needs ctx does not supply is refused, naming the missing fact", () => {
  for (const ctx of [undefined, { "git.isDirty": true }])
    assert.throws(
      () =>
        runGuardrail(MAIN_PUSH_GUARD, disasters({ events: PUSH_EVENTS }), {
          ctx,
        }).rows,
      (e: unknown) =>
        e instanceof TypeError && e.message.includes("git.branch"),
    );
});

// ---------------------------------------------------------------------------
// Only a gate that can block a tool call is in scope; no false green
// ---------------------------------------------------------------------------

test("a compiled gate that can never block a tool call is refused", () => {
  const gates = [
    experimental_defineStopGate({ on: "Stop", decide: () => deny("x") }),
    experimental_definePromptGate({
      on: "UserPromptSubmit",
      decide: () => deny("x"),
    }),
    experimental_defineHook({ on: "PostToolUse", decide: () => deny("x") }),
  ];
  for (const gate of gates)
    assert.throws(
      () => runGuardrail(gate, disasters({ harmless: [], spellings: [] })).rows,
      TypeError,
    );
});

/** A working guard that first sources an OPTIONAL rc file that is not there. */
function writeOptionalRcGuard(dir: string): string {
  const path = join(dir, "rc-guard.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
source "${dir}/no-such-guardrc" || true
input=$(cat)
echo "$input" | grep -qE 'git push (--force|-f)|rm -rf /|--no-verify|\\.ssh/id_|curl .*\\| *sh|reset --hard' \\
  && { echo "blocked" >&2; exit 2; }
exit 0
`,
  );
  return `bash ${path}`;
}

test("exit 2 on every disaster with a loader-ish stderr and no allow-expected case is scored, not crashed", () => {
  const dir = makeTmpDir("guardrail-rc");
  try {
    const results = runGuardrail(
      writeOptionalRcGuard(dir),
      disasters({ harmless: [], spellings: [] }),
    ).rows;
    assert.ok(results.every((r) => r.run === "ran" && r.blocked));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a crash that cannot be a block (exit 1) is crashed even with no allow-expected case", () => {
  const dir = makeTmpDir("guardrail-crash1");
  try {
    const results = runGuardrail(
      writeLibGuard(dir),
      disasters({ harmless: [], spellings: [] }),
    ).rows;
    assert.ok(results.every((r) => r.run === "crashed"));
  } finally {
    cleanupTmpDir(dir);
  }
});

test.skipIf(!hasPython())(
  "a missing script (exit 2) is crashed when the look-alikes fail too",
  () => {
    const dir = makeTmpDir("guardrail-213-twins");
    try {
      const results = runGuardrail(
        `python3 ${join(dir, "missing.py")}`,
        disasters({ spellings: [] }),
      ).rows;
      assert.ok(results.some((r) => r.expect === "allow"));
      assert.ok(results.every((r) => r.run === "crashed" && !r.blocked));
    } finally {
      cleanupTmpDir(dir);
    }
  },
);

test("a hook that answered no harmless case is not reported as allowing them", () => {
  const dir = makeTmpDir("guardrail-report-crash");
  try {
    const guard = writeLibGuard(dir);
    const report = formatGuardrailReport(
      guard,
      runGuardrail(guard, disasters({ spellings: [] })).rows,
    );
    assert.doesNotMatch(report, /allows [1-9]/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a harmless case the hook's condition does not select is allowed: the harness never spawns it", () => {
  // Blocks the selected force push; its condition selects none of the
  // look-alikes, so the harness lets each of them through unasked.
  const set = disasters({
    events: PUSH_EVENTS.filter((e) => e.id === "force-push"),
    spellings: [],
  });
  const opts = { condition: "Bash(git push *)" };
  const hook = `echo '{"decision":"block","reason":"x"}'`;
  const results = runGuardrail(hook, set, opts).rows;
  assert.ok(
    results.some((r) => r.expect === "allow" && r.run === "not-selected"),
  );
  assert.doesNotThrow(() => {
    assertChecks(runGuardrail(hook, set, opts), [guardrail()]);
  });
  assert.match(
    formatGuardrailReport(hook, results),
    /✅ allows .*\(not selected\)/,
  );
});

test("guardrail fails when a harmless case crashed", () => {
  const dir = makeTmpDir("guardrail-harmless-crash");
  try {
    // No disaster rows, so only the harmless rows can carry the failure.
    const set = disasters({
      events: [],
      harmless: disasters({ events: PUSH_EVENTS }).harmless,
    });
    const guard = writeLibGuard(dir);
    const result = runGuardrail(guard, set);
    assert.ok(result.rows.every((r) => r.run === "crashed"));
    assert.equal(guardrail().eval(result).pass, false);
    assert.throws(() => {
      assertChecks(result, [guardrail()]);
    }, /NEVER RAN/);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Other spellings of each disaster are on by default
// ---------------------------------------------------------------------------

/** Blocks the literal text `git push --force` only — one spelling. */
function writeLiteralGuard(dir: string): string {
  const path = join(dir, "literal.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
input=$(cat)
case "$input" in *"git push --force"*) echo blocked >&2; exit 2 ;; esac
exit 0
`,
  );
  return `bash ${path}`;
}

const FORCE_PUSH = DISASTER_CATALOG.filter((e) => e.id === "force-push");

test("the must-block half includes other spellings of each selected disaster by default", () => {
  const results = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({ events: FORCE_PUSH, harmless: [] }),
  ).rows;
  const spelled = results.filter((r) => r.event.id.startsWith("force-push~"));
  assert.ok(spelled.length > 0);
  assert.ok(spelled.every((r) => r.expect === "block" && r.blocked));
});

test("a guard that matches one spelling fails on another, named by its id", () => {
  const dir = makeTmpDir("guardrail-spelling");
  try {
    const guard = writeLiteralGuard(dir);
    const set = disasters({ events: FORCE_PUSH, harmless: [] });
    const missed = unblockedDisasters(runGuardrail(guard, set).rows);
    assert.ok(missed.length > 0);
    assert.ok(missed.every((r) => r.event.id.startsWith("force-push~")));
    assert.throws(() => {
      assertChecks(runGuardrail(guard, set), [guardrail()]);
    });
    assert.doesNotThrow(() => {
      assertChecks(runGuardrail(guard, { ...set, spellings: [] }), [
        guardrail(),
      ]);
    });
  } finally {
    cleanupTmpDir(dir);
  }
});

test("spellings: [...] replaces the generated ones", () => {
  const seed = FORCE_PUSH[0];
  assert.ok(seed);
  const mine = {
    ...seed,
    id: "force-push~mine",
    input: { command: "git push -f origin main" },
  };
  const results = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({ events: FORCE_PUSH, spellings: [mine], harmless: [] }),
  ).rows;
  assert.deepEqual(
    results.map((r) => r.event.id),
    ["force-push", "force-push~mine"],
  );
});

test("the seven seeds have a pinned number of spellings", () => {
  // Pinned so a family that silently stops applying is noticed: 13 families,
  // the subshell, the three nested-shell forms and `git -C .` among them.
  assert.equal(alternateSpellings(DISASTER_CATALOG).length, 167);
});

test("the assertion and the report name the spelling that got through by its id", () => {
  const dir = makeTmpDir("guardrail-spelling-id");
  try {
    const guard = writeLiteralGuard(dir);
    const set = disasters({ events: FORCE_PUSH, harmless: [] });
    assert.throws(() => {
      assertChecks(runGuardrail(guard, set), [guardrail()]);
    }, /force-push~\d+/);
    assert.match(
      formatGuardrailReport(guard, runGuardrail(guard, set).rows),
      /force-push~\d+/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("user events the spelling generator chokes on never throw at the user", () => {
  const events = [
    "git push --force-with-lease origin main",
    "rm -rf / # cleanup",
    "cat > f <<'EOF'\nrm -rf /\nEOF",
    "[[ -d .git ]] && git push --force",
    "DROP=1 psql -c 'drop table users'",
    "",
  ].map((command, i) => ({
    id: `mine-${String(i)}`,
    label: command,
    category: "destructive-git" as const,
    tool: "Bash",
    input: { command },
  }));
  const guard = experimental_defineHook({
    on: "PreToolUse",
    decide: () => deny("everything"),
  });
  assert.doesNotThrow(
    () => runGuardrail(guard, disasters({ events, harmless: [] })).rows,
  );
});

test("a spelling of a user event that cannot be proven is skipped and counted, never a miss", () => {
  const bogus = { families: [{ name: "bogus", rewrite: () => ["ls"] }] };
  const { proven, unproven } = spellingCases(FORCE_PUSH, bogus);
  assert.deepEqual(proven, []);
  assert.deepEqual(
    unproven.map((e) => e.id),
    ["force-push~unproven1"],
  );
  const skipped = unproven.map((event) => ({
    expect: "block" as const,
    event,
    blocked: false,
    exitCode: 0,
    run: "unproven" as const,
    ran: false,
    reason: "couldn't prove",
  }));
  assert.deepEqual(unblockedDisasters(skipped), []);
  assert.match(formatGuardrailReport("x", skipped), /1 spelling\(s\) skipped/);
});

// ---------------------------------------------------------------------------
// v53: the runner returns, the check asserts, the case set is a value
// ---------------------------------------------------------------------------

test("guardrail is a check: it passes with a count, fails with the misses, and serializes", () => {
  const set = disasters({ events: PUSH_EVENTS, harmless: [], spellings: [] });
  const held = guardrail().eval(runGuardrail(PUSH_FORCE_GUARD, set));
  assert.equal(held.pass, true);
  assert.match(held.message, /blocked 2\/2 dangerous case\(s\)/);
  const missed = guardrail().eval(
    runGuardrail(PUSH_FORCE_GUARD, disasters({ harmless: [], spellings: [] })),
  );
  assert.equal(missed.pass, false);
  assert.equal(missed.score, 0);
  assert.match(missed.message, /did NOT block 5 dangerous action\(s\)/);
  assert.deepEqual(guardrail().toJSON(), { kind: "guardrail" });
});

test("runGuardrail returns the rows without throwing, and names the hook and the set", () => {
  const r = runGuardrail(
    PUSH_FORCE_GUARD,
    disasters({ harmless: [], spellings: [] }),
  );
  assert.equal(r.kind, "disasters");
  assert.equal(r.hook, "compiled hook");
  assert.equal(r.rows.length, DISASTER_CATALOG.length);
  assert.ok(unblockedDisasters(r.rows).length > 0);
});

test("disasters() is the stock set, and the default of runGuardrail", () => {
  const d = disasters();
  assert.equal(d.kind, "disasters");
  assert.deepEqual(d.events, DISASTER_CATALOG);
  assert.equal(d.spellings.length, alternateSpellings(DISASTER_CATALOG).length);
  assert.ok(d.harmless.length > 0);
  assert.deepEqual(d.unproven, []);
  assert.equal(
    runGuardrail(PUSH_FORCE_GUARD).rows.length,
    d.events.length + d.spellings.length + d.harmless.length,
  );
  assert.deepEqual(
    disasters({ categories: ["destructive-fs"] }).events.map((e) => e.id),
    ["rm-rf"],
  );
});
