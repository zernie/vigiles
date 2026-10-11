/**
 * Wiring tests for the eval LOCK through `runEvalWith` with an INJECTED runner
 * (no model) — proves the seam end to end: `update` records a committed lock,
 * `check` REPLAYS it without ever calling the runner (the CI-binary-free promise),
 * and a missing/stale lock fails. The lock module's pure units live in
 * `eval-lock.test.ts`; this is the integration over the real entry point.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, writeFileSync } from "node:fs";

import {
  runEvalWith,
  measureTriggerRateWith,
  type AgentRunArgs,
} from "./eval.js";
import { readLock, lockPath } from "./eval-lock.js";
import { ARGV_REST } from "./core/stub-rules.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vig-lockwire-"));
}

/** A committed lock round-trips through JSON, which drops `undefined`-valued keys
 *  (e.g. `errored: undefined`). The replayed report is the JSON-normalized form —
 *  identical for any consumer (a missing key reads as `undefined`). */
function jnorm<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** A minimal on-disk plugin dir with one skill (so `hashDir` has content). */
function makeSkillPlugin(
  root: string,
  opts: { body?: string; description?: string } = {},
): string {
  const skill = join(root, "skills", "foo");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nname: foo\ndescription: ${opts.description ?? "foo skill"}\n---\n${opts.body ?? "do the thing"}\n`,
  );
  return root;
}

// A dated model id → no floating-alias warning noise in the test output.
const MODEL = "claude-sonnet-4-6-20260101";

/** A counting fake runner returning a fixed result (deterministic report). */
function countingRunner(): {
  run: (a: AgentRunArgs) => Promise<{ code: number; stdout: string }>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: (_a) => {
      calls++;
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ type: "result", result: "ok", num_turns: 1 }),
      });
    },
    calls: () => calls,
  };
}

/** These specs drive a fake runner, so nothing is inherited by a real child. */
const INHERIT = {
  kind: "inherit",
  reason: "unit test: a fake runner",
} as const;
function spec(dir: string, mode: "off" | "check" | "update", task = "do it") {
  return {
    name: "wiring eval",
    env: INHERIT,
    arms: { run: {} },
    task,
    trials: 1,
    model: MODEL,
    spacingSec: 0,
    measure: (ctx: { turns: number }) => ({ turns: ctx.turns }),
    lock: { mode, dir: dir, evalApiVersion: 1 } as const,
  };
}

test("lock off: runner is driven, no lock file written", async () => {
  const dir = tmp();
  try {
    const r = countingRunner();
    await runEvalWith(spec(dir, "off"), r.run);
    assert.ok(r.calls() > 0, "runner should be called when lock is off");
    assert.equal(existsSync(lockPath(dir, "wiring eval")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock update: drives the runner AND writes a committed lock", async () => {
  const dir = tmp();
  try {
    const r = countingRunner();
    const report = await runEvalWith(spec(dir, "update"), r.run);
    assert.ok(r.calls() > 0, "update drives the model");
    const lock = readLock(dir, "wiring eval");
    assert.ok(lock, "a lock file is written");
    assert.equal(lock?.name, "wiring eval");
    assert.equal(lock?.model, MODEL);
    // The recorded report is the run's report (replayed verbatim on --check).
    assert.deepEqual(lock?.report, report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock check with a matching lock: REPLAYS — runner is NEVER called", async () => {
  const dir = tmp();
  try {
    // Record first.
    const rec = countingRunner();
    const recorded = await runEvalWith(spec(dir, "update"), rec.run);
    // Now check with a FRESH counting runner over the SAME inputs.
    const chk = countingRunner();
    const replayed = await runEvalWith(spec(dir, "check"), chk.run);
    assert.equal(
      chk.calls(),
      0,
      "check must NOT call the runner (no model in CI)",
    );
    assert.deepEqual(replayed, recorded, "check returns the committed report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock check with NO committed lock: fails 'missing'", async () => {
  const dir = tmp();
  try {
    const r = countingRunner();
    await assert.rejects(
      () => runEvalWith(spec(dir, "check"), r.run),
      /lock missing/,
    );
    assert.equal(r.calls(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock check after an INPUT change: fails 'stale' (the core gate)", async () => {
  const dir = tmp();
  try {
    // Record with one task...
    await runEvalWith(spec(dir, "update", "task A"), countingRunner().run);
    // ...then check with a DIFFERENT task (an input change) → stale.
    const chk = countingRunner();
    await assert.rejects(
      () => runEvalWith(spec(dir, "check", "task B"), chk.run),
      /STALE|changed/,
    );
    assert.equal(chk.calls(), 0, "a stale check never reaches the model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock check after a measure-only change still REPLAYS (assertions re-run live)", async () => {
  const dir = tmp();
  try {
    await runEvalWith(spec(dir, "update"), countingRunner().run);
    // Same inputs, DIFFERENT measure fn — the lock hashes inputs, not the metric,
    // so this is a valid replay (no model), and the new measure is irrelevant to
    // the replayed report (the script's own assertions judge it).
    const chk = countingRunner();
    const s = spec(dir, "check");
    const withNewMeasure = { ...s, measure: () => ({ turns: 999 }) };
    await runEvalWith(withNewMeasure, chk.run);
    assert.equal(chk.calls(), 0, "a metric edit is a valid replay, not stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trigger-rate seam: update records, check replays the skill's report (no model)", async () => {
  const dir = tmp();
  try {
    const pluginDir = makeSkillPlugin(join(dir, "plugin"));
    const lockDir = join(dir, "locks");
    const triggerSpec = {
      name: "foo trigger",
      pluginDir,
      prompts: ["use the foo skill", "please foo this"],
      fired: () => true, // deterministic firing without a model
      minPrompts: 1,
      minDistance: 0,
      trials: 1,
      model: "claude-sonnet-4-6-20260101",
      spacingSec: 0,
      lock: { mode: "update" as const, dir: lockDir, evalApiVersion: 1 },
    };
    const rec = countingRunner();
    const recorded = await measureTriggerRateWith(triggerSpec, rec.run);
    assert.ok(rec.calls() > 0, "update drives the model");
    assert.equal(recorded.rate, 1); // fired on every relevant run
    const lock = readLock(lockDir, "foo trigger");
    assert.deepEqual(lock?.report, jnorm(recorded));

    // check: same skill + prompts → replay, runner never called.
    const chk = countingRunner();
    const replayed = await measureTriggerRateWith(
      { ...triggerSpec, lock: { ...triggerSpec.lock, mode: "check" as const } },
      chk.run,
    );
    assert.equal(chk.calls(), 0, "check must not drive the model");
    assert.deepEqual(replayed, jnorm(recorded));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trigger-rate seam: the lock hashes the TRIGGER SURFACE (description stale, body not)", async () => {
  const dir = tmp();
  try {
    const pluginDir = makeSkillPlugin(join(dir, "plugin"), {
      body: "original body",
      description: "foo skill",
    });
    const lockDir = join(dir, "locks");
    const base = {
      name: "foo trigger",
      pluginDir,
      prompts: ["use the foo skill", "please foo this"],
      fired: () => true,
      minPrompts: 1,
      minDistance: 0,
      trials: 1,
      model: "claude-sonnet-4-6-20260101",
      spacingSec: 0,
    };
    await measureTriggerRateWith(
      { ...base, lock: { mode: "update" as const, dir: lockDir } },
      countingRunner().run,
    );

    // Edit only the BODY — trigger-rate stubs bodies (selection is by frontmatter),
    // so the measured surface is unchanged → a valid replay, NOT stale.
    makeSkillPlugin(join(dir, "plugin"), {
      body: "COMPLETELY different body",
      description: "foo skill",
    });
    const bodyChk = countingRunner();
    await measureTriggerRateWith(
      { ...base, lock: { mode: "check" as const, dir: lockDir } },
      bodyChk.run,
    );
    assert.equal(
      bodyChk.calls(),
      0,
      "a body-only edit is not measured → replay",
    );

    // Edit the DESCRIPTION — that IS the trigger surface → stale.
    makeSkillPlugin(join(dir, "plugin"), {
      body: "COMPLETELY different body",
      description: "an entirely different trigger description",
    });
    const descChk = countingRunner();
    await assert.rejects(
      () =>
        measureTriggerRateWith(
          { ...base, lock: { mode: "check" as const, dir: lockDir } },
          descChk.run,
        ),
      /STALE|changed/,
    );
    assert.equal(descChk.calls(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock update under GITHUB_ACTIONS + a floating model emits an annotation + drift warning", async () => {
  const dir = tmp();
  const prev = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true"; // → ::notice:: / ::warning:: annotations
  try {
    const r = countingRunner();
    // A floating alias (not dated) → warnFloatingModel fires; both the lock
    // update message and that warning take the GitHub-annotation path.
    await runEvalWith({ ...spec(dir, "update"), model: "sonnet" }, r.run);
    assert.ok(r.calls() > 0);
    assert.ok(readLock(dir, "wiring eval"), "the lock is still written");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock messages WITHOUT GITHUB_ACTIONS take the plain stderr/stdout path", async () => {
  // CI sets GITHUB_ACTIONS=true globally, so the annotation branch is covered
  // there; this DELETES it to also exercise the console.warn/console.log else
  // branches (warn=true via the unnamed-skip path, warn=false via a normal
  // update) regardless of the ambient environment.
  const dir = tmp();
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    // (a) named update → emitLockMessage(..., warn:false) → console.log
    await runEvalWith(spec(dir, "update"), countingRunner().run);
    assert.ok(readLock(dir, "wiring eval"), "the lock is written");
    // (b) unnamed update → emitLockMessage(..., warn:true) → console.warn
    const r = countingRunner();
    await runEvalWith({ ...spec(dir, "update"), name: undefined }, r.run);
    assert.ok(r.calls() > 0);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Would a lock recorded with `recorded` be STALE under `checked`? `--check`
 * compares exactly this hash (`decideLock`), so equal hashes replay and
 * different ones are stale.
 */
async function staleAfter(
  recorded: (s: ReturnType<typeof spec>) => Record<string, unknown>,
  checked: (s: ReturnType<typeof spec>) => Record<string, unknown>,
): Promise<"stale" | "replayed"> {
  const root = tmp();
  try {
    const a = await evalHash(root, recorded);
    const b = await evalHash(root, checked);
    assert.notEqual(a, "", "the recording run wrote a lock");
    return a === b ? "replayed" : "stale";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ghStub = (re: RegExp, stdout = "[]") => ({
  name: "gh",
  rules: [
    {
      argv: ["issue", "create", ARGV_REST],
      reply: { kind: "always", stdout: "https://github.com/o/r/issues/1\n" },
    },
    { argv: ["api", re], reply: { kind: "always", stdout } },
  ],
});
const withStubs =
  (...stubs: readonly unknown[]) =>
  (s: ReturnType<typeof spec>) => ({ ...s, stubs });

test("lock check after a stub REPLY change: stale (an answer is a model-facing input)", async () => {
  assert.equal(
    await staleAfter(
      withStubs(ghStub(/^repos\//, "[]")),
      withStubs(ghStub(/^repos\//, '[{"number":1}]')),
    ),
    "stale",
  );
});

test("lock check after a RegExp TOKEN change: stale — the key uses the encoding, not JSON.stringify (which gives {})", async () => {
  assert.equal(
    await staleAfter(
      withStubs(ghStub(/^repos\//)),
      withStubs(ghStub(/^search\//)),
    ),
    "stale",
    "a different RegExp source",
  );
  assert.equal(
    await staleAfter(
      withStubs(ghStub(/^repos\//)),
      withStubs(ghStub(/^repos\//i)),
    ),
    "stale",
    "the same source with different flags",
  );
});

test("lock check with the stubs declared in another order: replayed (the key ignores declaration order)", async () => {
  const psql = {
    name: "psql",
    rules: [{ argv: ["-c", ARGV_REST], reply: { kind: "always" } }],
  };
  assert.equal(
    await staleAfter(
      withStubs(ghStub(/^repos\//), psql),
      withStubs(psql, ghStub(/^repos\//)),
    ),
    "replayed",
  );
});

test("lock CHECK on an unnamed eval: throws (never calls the model in CI)", async () => {
  const dir = tmp();
  try {
    const r = countingRunner();
    await assert.rejects(
      () => runEvalWith({ ...spec(dir, "check"), name: undefined }, r.run),
      /unnamed eval cannot run in CI/,
    );
    assert.equal(r.calls(), 0, "an unnamed check must NOT reach the model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock check after an env change: stale for the kind and the seed, replayed for an inherit reason", async () => {
  const ephemeral = (s: ReturnType<typeof spec>) => ({
    ...s,
    env: { kind: "ephemeral" },
  });
  const seeded = (contents: string) => (s: ReturnType<typeof spec>) => ({
    ...s,
    env: {
      kind: "ephemeral",
      home: { kind: "files", files: { ".config/x/y.txt": contents } },
    },
  });
  assert.equal(
    await staleAfter((s) => s, ephemeral),
    "stale",
    "inherit → ephemeral",
  );
  assert.equal(
    await staleAfter(ephemeral, seeded("z")),
    "stale",
    "a seed added",
  );
  assert.equal(
    await staleAfter(seeded("z"), seeded("w")),
    "stale",
    "a seed's contents",
  );
  assert.equal(
    await staleAfter(
      (s) => s,
      (s) => ({ ...s, env: { kind: "inherit", reason: "reworded" } }),
    ),
    "replayed",
    "the reason is prose, not an input",
  );
});

test("trigger-rate lock check after a HARNESS switch: fails 'stale' (driver is an input)", async () => {
  const dir = tmp();
  try {
    const pluginDir = makeSkillPlugin(join(dir, "plugin"));
    const lockDir = join(dir, "locks");
    const base = {
      name: "foo trigger",
      pluginDir,
      prompts: ["use the foo skill", "please foo this"],
      fired: () => true,
      minPrompts: 1,
      minDistance: 0,
      trials: 1,
      model: "claude-sonnet-4-6-20260101",
      spacingSec: 0,
    };
    // Record on the default harness (claude-code)…
    await measureTriggerRateWith(
      {
        ...base,
        lock: { mode: "update" as const, dir: lockDir, evalApiVersion: 1 },
      },
      countingRunner().run,
    );
    // …then check as if driven by Codex (same prompts/model/plugin) → stale.
    const chk = countingRunner();
    await assert.rejects(
      () =>
        measureTriggerRateWith(
          {
            ...base,
            lock: { mode: "check" as const, dir: lockDir, evalApiVersion: 1 },
          },
          chk.run,
          undefined,
          undefined,
          "codex",
        ),
      /STALE|changed/,
    );
    assert.equal(chk.calls(), 0, "a stale check never reaches the model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval-arm lock with a plugin: ${PLUGIN_ROOT} path is normalized (location-independent)", async () => {
  const root = tmp();
  // The SAME plugin (root-based hook) at TWO different absolute paths.
  const mkPlugin = (dir: string): string => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/h.sh" },
              ],
            },
          ],
        },
      }),
    );
    return dir;
  };
  const dirA = mkPlugin(mkdtempSync(join(root, "pa-")));
  const dirB = mkPlugin(mkdtempSync(join(root, "pb-")));
  const lockDir = join(root, "locks");
  const spc = (plugin: string, mode: "update" | "check") =>
    ({
      name: "plugin eval",
      env: INHERIT,
      arms: { run: { plugin } },
      task: "do it",
      trials: 1,
      model: MODEL,
      spacingSec: 0,
      measure: (ctx: { turns: number }) => ({ turns: ctx.turns }),
      lock: { mode, dir: lockDir, evalApiVersion: 1 },
    }) as const;
  try {
    // Record with the plugin at dirA…
    await runEvalWith(spc(dirA, "update"), countingRunner().run);
    // …then check the SAME plugin at a DIFFERENT abs path → must REPLAY, not go
    // stale (the expanded ${CLAUDE_PLUGIN_ROOT} differs only by the abs prefix).
    const chk = countingRunner();
    await runEvalWith(spc(dirB, "check"), chk.run);
    assert.equal(
      chk.calls(),
      0,
      "same plugin at a different path must replay, not falsely go stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval-arm lock with a HOOKLESS plugin: settings:undefined doesn't throw", async () => {
  // A plugin that ships only a skill (no hooks/settings) → resolveHarness returns
  // settings:undefined; stripPluginRoot must pass it through, not `.split` it.
  const root = tmp();
  const pluginDir = makeSkillPlugin(join(root, "p"));
  const lockDir = join(root, "locks");
  const spc = (mode: "update" | "check") =>
    ({
      name: "hookless plugin eval",
      env: INHERIT,
      arms: { run: { plugin: pluginDir } },
      task: "do it",
      trials: 1,
      model: MODEL,
      spacingSec: 0,
      measure: (ctx: { turns: number }) => ({ turns: ctx.turns }),
      lock: { mode, dir: lockDir, evalApiVersion: 1 },
    }) as const;
  try {
    // Must not throw (the bug: JSON.stringify(undefined).split(...)).
    await runEvalWith(spc("update"), countingRunner().run);
    const chk = countingRunner();
    await runEvalWith(spc("check"), chk.run);
    assert.equal(chk.calls(), 0, "same hookless plugin replays");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock on but NO name: loud skip — runner runs, no lock written", async () => {
  const dir = tmp();
  try {
    const r = countingRunner();
    const s = { ...spec(dir, "update"), name: undefined };
    await runEvalWith(s, r.run);
    assert.ok(r.calls() > 0, "an unnamed eval still runs (lock skipped)");
    // No lock file for the default "eval" slug either — the skip is total.
    assert.equal(existsSync(lockPath(dir, "eval")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETENESS GUARD — the structural test for the bug class the review kept
// finding: a model-facing input omitted from the lock hash, so `--check` replays
// stale results. Each row below mutates ONE input that steers the run and asserts
// the inputsHash CHANGES. ADD A ROW whenever you add an input to EvalSpec/
// TriggerRateSpec that affects the model-facing run — a new input that isn't
// hashed makes a row fail here (in CI), instead of a reviewer finding it later.
// (Plugin/pluginDir CONTENT changes are covered by their own dir-hash tests.)
// ─────────────────────────────────────────────────────────────────────────────

const ALT_MODEL = "claude-opus-4-8-20260101"; // dated → no floating-alias warning

/** The committed lock's inputsHash for a freshly-recorded eval (fake runner). */
async function evalHash(
  root: string,
  mut: (s: ReturnType<typeof spec>) => Record<string, unknown>,
): Promise<string> {
  const dir = mkdtempSync(join(root, "h-"));
  const base = { ...spec(dir, "update"), allowedTools: ["Read"] };
  const s = mut(base);
  await runEvalWith(s as never, countingRunner().run);
  const lock = readLock(dir, (s.name as string) ?? "wiring eval");
  return lock?.inputsHash ?? "";
}

test("COMPLETENESS: every model-facing runEval input changes the lock hash", async () => {
  const root = tmp();
  try {
    const baseHash = await evalHash(root, (s) => s);
    const variants: Record<
      string,
      (s: ReturnType<typeof spec>) => Record<string, unknown>
    > = {
      task: (s) => ({ ...s, task: "a DIFFERENT task" }),
      model: (s) => ({ ...s, model: ALT_MODEL }),
      "allowedTools (tools)": (s) => ({ ...s, allowedTools: ["Read", "Bash"] }),
      fixture: (s) => ({ ...s, fixture: { "extra.txt": "x" } }),
      "arm.files": (s) => ({
        ...s,
        arms: { run: { files: { "f.txt": "y" } } },
      }),
      "arm.settings": (s) => ({
        ...s,
        arms: { run: { settings: { permissions: { allow: ["Bash"] } } } },
      }),
      "arm.model": (s) => ({ ...s, arms: { run: { model: ALT_MODEL } } }),
      "arm.interceptTools": (s) => ({
        ...s,
        arms: { run: { interceptTools: [{ tool: "Bash" }] } },
      }),
      stubs: withStubs(ghStub(/^repos\//)),
      "env.kind": (s) => ({ ...s, env: { kind: "ephemeral" } }),
      "env.home": (s) => ({
        ...s,
        env: { kind: "ephemeral", home: { kind: "files", files: { a: "b" } } },
      }),
    };
    for (const [field, mut] of Object.entries(variants)) {
      const h = await evalHash(root, mut);
      assert.notEqual(
        h,
        baseHash,
        `changing \`${field}\` must change the lock inputsHash (else --check replays stale)`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMPLETENESS: every model-facing trigger-rate input changes the lock hash", async () => {
  const root = tmp();
  const pluginDir = makeSkillPlugin(join(root, "plugin"));
  const baseSpec = (dir: string) => ({
    name: "ctrigger",
    pluginDir,
    prompts: ["use the foo skill", "please foo this"],
    irrelevantPrompts: ["what's the weather", "tell me a joke"],
    fired: () => true,
    minPrompts: 1,
    minDistance: 0,
    trials: 1,
    model: MODEL,
    spacingSec: 0,
    lock: { mode: "update" as const, dir, evalApiVersion: 1 },
  });
  const hashOf = async (
    mut: (s: ReturnType<typeof baseSpec>) => Record<string, unknown>,
    harness?: string,
  ): Promise<string> => {
    const dir = mkdtempSync(join(root, "ht-"));
    const s = mut(baseSpec(dir));
    await measureTriggerRateWith(
      s as never,
      countingRunner().run,
      undefined,
      undefined,
      harness,
    );
    return readLock(dir, "ctrigger")?.inputsHash ?? "";
  };
  try {
    const baseHash = await hashOf((s) => s);
    const variants: Record<
      string,
      [(s: ReturnType<typeof baseSpec>) => Record<string, unknown>, string?]
    > = {
      prompts: [(s) => ({ ...s, prompts: ["totally different ask here"] })],
      irrelevantPrompts: [
        (s) => ({ ...s, irrelevantPrompts: ["a brand new irrelevant prompt"] }),
      ],
      model: [(s) => ({ ...s, model: ALT_MODEL })],
      harness: [(s) => s, "codex"], // the driver/harness identity
    };
    for (const [field, [mut, harness]] of Object.entries(variants)) {
      const h = await hashOf(mut, harness);
      assert.notEqual(
        h,
        baseHash,
        `changing \`${field}\` must change the trigger lock inputsHash`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
