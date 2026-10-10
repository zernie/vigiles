/**
 * Tests for `--effort` support across the eval tier — the flag, the env pin, the
 * fail-closed rejection guard, both hashes, and the Codex deferral. Model-free.
 *
 * The load-bearing case is the ENV PIN. Effort has three inputs (flag, settings
 * key, `CLAUDE_CODE_EFFORT_LEVEL`) and the env var outranks the flag, while
 * `EPHEMERAL_ALLOW_PREFIXES` passes `CLAUDE_*` through on purpose. Hashing effort
 * WITHOUT pinning it would make the lock confidently wrong — recording `low` over
 * a run that executed at the shell's `max` — which is the very defect this
 * feature exists to prevent.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentArgs,
  runEvalWith,
  resolveSpawnEnv,
  pinEffortEnv,
  effortRejection,
  withEffortGuard,
  EFFORT_ENV_VAR,
  type AgentRunArgs,
  type AgentRunner,
  type RunOut,
} from "./eval.js";
import { cacheKey } from "./eval-cache.js";
import { evalInputsHash, readLock } from "./eval-lock.js";
import {
  refuseCodexEffort,
  codexEvalAgentRunner,
} from "./adapters/codex/eval.js";

const baseArgs: AgentRunArgs = {
  task: "t",
  cwd: "/tmp/x",
  model: "claude-sonnet-5",
  tools: ["Read"],
  hasSettings: false,
  pluginDir: undefined,
  timeoutMs: 1000,
};

/* ---------------------------------------------------------------- the flag */

test("buildAgentArgs passes --effort straight after the model when declared", () => {
  const args = buildAgentArgs({ ...baseArgs, effort: "low" });
  const i = args.indexOf("--effort");
  assert.notEqual(i, -1, "the flag must reach the binary");
  assert.equal(args[i + 1], "low");
  assert.equal(args[i - 1], baseArgs.model, "sits with the other model knobs");
});

test("buildAgentArgs stringifies an integer budget", () => {
  // Not a literal union on purpose: the binary documents "or an integer".
  const args = buildAgentArgs({ ...baseArgs, effort: 4096 });
  assert.equal(args[args.indexOf("--effort") + 1], "4096");
});

test("buildAgentArgs omits the flag entirely when effort is undefined", () => {
  // Byte-identical to the pre-effort argv, so nothing existing changes.
  assert.equal(buildAgentArgs(baseArgs).includes("--effort"), false);
});

/* ------------------------------------------------------------- the env pin */

test("pinEffortEnv sets the var when effort is declared, beating the shell", () => {
  const out = pinEffortEnv({ [EFFORT_ENV_VAR]: "max", PATH: "/bin" }, "low");
  assert.equal(out[EFFORT_ENV_VAR], "low");
  assert.equal(out.PATH, "/bin", "unrelated env is untouched");
});

test("pinEffortEnv DELETES an inherited var when effort is omitted", () => {
  // "Omit" must mean the harness default, never "whatever this machine
  // exported" — otherwise an omitted effort is a hidden, unhashed input.
  const out = pinEffortEnv(
    { [EFFORT_ENV_VAR]: "max", PATH: "/bin" },
    undefined,
  );
  assert.equal(EFFORT_ENV_VAR in out, false);
  assert.equal(out.PATH, "/bin");
});

test("pinEffortEnv does not mutate its input", () => {
  const src = { [EFFORT_ENV_VAR]: "max" };
  pinEffortEnv(src, "low");
  assert.equal(src[EFFORT_ENV_VAR], "max");
});

test("resolveSpawnEnv pins effort over an ambient var on the OVERLAY path", () => {
  const env = resolveSpawnEnv(
    { effort: "low" },
    {
      [EFFORT_ENV_VAR]: "max",
      SECRET: "s",
    },
  );
  assert.equal(env[EFFORT_ENV_VAR], "low");
  assert.equal(env.SECRET, "s", "overlay still inherits the base env");
});

test("resolveSpawnEnv pins effort on the SCRUBBED ephemeral path too", () => {
  // The scrub does not save us here: CLAUDE_* is allow-listed by prefix, so an
  // ambient effort survives into an ephemeral run unless it is pinned.
  const env = resolveSpawnEnv(
    { env: { [EFFORT_ENV_VAR]: "max" }, replaceEnv: true, effort: "low" },
    { SECRET: "s" },
  );
  assert.equal(env[EFFORT_ENV_VAR], "low");
  assert.equal(env.SECRET, undefined, "the scrub still drops the host env");
});

test("resolveSpawnEnv strips an ambient effort when the spec declares none", () => {
  const env = resolveSpawnEnv({}, { [EFFORT_ENV_VAR]: "max", PATH: "/bin" });
  assert.equal(EFFORT_ENV_VAR in env, false);
  assert.equal(env.PATH, "/bin");
});

/* ------------------------------------------------------- the rejection guard */

const REJECTION =
  "Unknown --effort value 'bogus' — ignoring it and using the default effort. " +
  "Valid values: low, medium, high, xhigh, max.";

test("effortRejection reads the harness's own refusal off stderr", () => {
  const got = effortRejection({ code: 0, stdout: "", stderr: REJECTION });
  assert.match(String(got), /Unknown --effort value 'bogus'/);
});

test("effortRejection is null on a clean run", () => {
  assert.equal(
    effortRejection({ code: 0, stdout: "all good", stderr: "" }),
    null,
  );
});

test("withEffortGuard THROWS on a rejected effort instead of sampling it", async () => {
  // The harness exits 0 and silently runs at its default, so without this the
  // run would produce a number from a configuration nobody asked for.
  const runner = (): Promise<RunOut> =>
    Promise.resolve({ code: 0, stdout: "", stderr: REJECTION });
  await assert.rejects(
    withEffortGuard(runner)({ ...baseArgs, effort: "bogus" }),
    /the harness rejected effort "bogus"/,
  );
});

test("withEffortGuard passes a clean run through untouched", async () => {
  const out: RunOut = { code: 0, stdout: "fine", stderr: "" };
  assert.deepEqual(
    await withEffortGuard(() => Promise.resolve(out))(baseArgs),
    out,
  );
});

/* ------------------------------------------------------------- both hashes */

const keyBase = {
  task: "t",
  model: "m",
  tools: ["Read"],
  files: {},
  settings: undefined,
  trialIndex: 0,
};

test("the CACHE key changes with effort", () => {
  assert.notEqual(
    cacheKey({ ...keyBase, effort: "low" }),
    cacheKey({ ...keyBase, effort: "max" }),
  );
});

test("an absent effort leaves the CACHE key byte-identical to today's", () => {
  // Entries recorded before effort existed must stay valid, not silently miss.
  assert.equal(cacheKey({ ...keyBase, effort: undefined }), cacheKey(keyBase));
});

const lockBase = { model: "m", evalApiVersion: 1, inputs: { a: 1 } };

test("the LOCK hash changes with effort", () => {
  assert.notEqual(
    evalInputsHash({ ...lockBase, effort: "low" }),
    evalInputsHash({ ...lockBase, effort: "max" }),
  );
});

test("an absent effort leaves the LOCK hash byte-identical — old locks replay", () => {
  // The additive claim, asserted rather than assumed: a lock committed before
  // effort existed must not read as STALE and demand a paid re-run.
  assert.equal(
    evalInputsHash({ ...lockBase, effort: undefined }),
    evalInputsHash(lockBase),
  );
});

/* ------------------------------------------------------- the Codex deferral */

test("Codex REFUSES a declared effort loudly rather than dropping it", () => {
  assert.throws(() => {
    refuseCodexEffort("low");
  }, /not supported on the Codex adapter/);
});

test("Codex is silent when no effort is declared", () => {
  assert.doesNotThrow(() => {
    refuseCodexEffort(undefined);
  });
});

/* ------------------------------------------------------------- the WIRING */
/*
 * The unit tests above assert the INTERFACES. They cannot see the fills — delete
 * `effort: runArgs.effort` from the cache key or the lock inputs and every one of
 * them stays green. These drive the real entry point with a fake runner, so the
 * spec → runArgs → hash path is asserted end to end.
 */

const MODEL = "claude-sonnet-4-6-20260101";

/** A fake runner that records the args it was handed. */
function recordingRunner(): {
  run: (a: AgentRunArgs) => Promise<RunOut>;
  seen: AgentRunArgs[];
} {
  const seen: AgentRunArgs[] = [];
  return {
    seen,
    run: (a) => {
      seen.push(a);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ type: "result", result: "ok", num_turns: 1 }),
        stderr: "",
      });
    },
  };
}

/** These specs drive a fake runner, so nothing is inherited by a real child. */
const INHERIT = {
  kind: "inherit",
  reason: "unit test: a fake runner",
} as const;
function evalSpec(dir: string, extra: Record<string, unknown> = {}) {
  return {
    name: "effort wiring",
    env: INHERIT,
    arms: { run: {} },
    task: "do it",
    trials: 1,
    model: MODEL,
    spacingSec: 0,
    measure: (ctx: { turns: number }) => ({ turns: ctx.turns }),
    lock: { mode: "off", dir, evalApiVersion: 1 } as const,
    ...extra,
  };
}

test("a spec-level effort reaches the runner's args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vig-effort-"));
  try {
    const r = recordingRunner();
    await runEvalWith(evalSpec(dir, { effort: "low" }), r.run);
    assert.ok(r.seen.length > 0);
    assert.equal(r.seen[0].effort, "low");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ARM-level effort overrides the eval-level one", async () => {
  // Effort-as-an-arm is the whole point for an A/B: "does my harness still hold
  // at the cheaper budget?" is the same question model-as-an-arm already answers.
  const dir = mkdtempSync(join(tmpdir(), "vig-effort-"));
  try {
    const r = recordingRunner();
    await runEvalWith(
      evalSpec(dir, {
        effort: "low",
        arms: { cheap: {}, rich: { effort: "max" } },
      }),
      r.run,
    );
    const byEffort = r.seen.map((a) => a.effort).sort();
    assert.deepEqual(byEffort, ["low", "max"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * MEASURED LIMIT of the test below, stated rather than papered over. Effort
 * reaches the lock hash through TWO fills — the `withEvalLock` chokepoint and the
 * per-arm lock inputs — so a mutation removing EITHER ONE leaves this green.
 * Verified 2026-09-01 with the patch proven landed; removing BOTH fails here.
 * That is overlap (two populations: any seam vs. a per-arm override), not a dead
 * line, and neither fill is individually pinned by behaviour. Do not "fix" this
 * by deleting one of them.
 */
test("changing effort makes a committed lock STALE (the hash fill is wired)", async () => {
  // The assertion the whole feature turns on: without effort in the lock inputs,
  // `--check` would happily replay a report recorded at a different budget.
  const dir = mkdtempSync(join(tmpdir(), "vig-effort-"));
  try {
    const r = recordingRunner();
    const lock = (mode: "update" | "check") => ({
      mode,
      dir,
      evalApiVersion: 1,
    });
    await runEvalWith(
      { ...evalSpec(dir, { effort: "low" }), lock: lock("update") },
      r.run,
    );
    const recorded = readLock(dir, "effort wiring");
    assert.equal(recorded?.effort, "low", "the lock records WHICH effort ran");

    // Same spec, different budget → must refuse to replay.
    await assert.rejects(
      runEvalWith(
        { ...evalSpec(dir, { effort: "max" }), lock: lock("check") },
        r.run,
      ),
      /stale/i,
    );
    // And the unchanged one still replays, so the gate is not simply always-stale.
    await assert.doesNotReject(
      runEvalWith(
        { ...evalSpec(dir, { effort: "low" }), lock: lock("check") },
        r.run,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CACHE fill is wired: same effort replays, a different one re-runs", async () => {
  // `cache` defaults to "off", so nothing above ever executes the cache-key fill.
  // Without this, deleting `effort: runArgs.effort` from it stays green.
  const dir = mkdtempSync(join(tmpdir(), "vig-effort-"));
  try {
    const r = recordingRunner();
    const cached = (effort: string) => ({
      ...evalSpec(dir, { effort }),
      cache: "readwrite" as const,
      cacheDir: dir,
    });
    await runEvalWith(cached("low"), r.run);
    const afterFirst = r.seen.length;
    await runEvalWith(cached("low"), r.run);
    assert.equal(r.seen.length, afterFirst, "same effort → served from cache");
    await runEvalWith(cached("max"), r.run);
    assert.ok(
      r.seen.length > afterFirst,
      "a different effort must NOT replay another budget's result",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Codex runner refuses BEFORE it spawns anything", async () => {
  // Asserts the CALL site, not just `refuseCodexEffort` itself — the refusal is
  // the first statement, so this throws without reaching the binary.
  await assert.rejects(
    Promise.resolve().then(() =>
      codexEvalAgentRunner({ ...baseArgs, effort: "low" }),
    ),
    /not supported on the Codex adapter/,
  );
});

test("withEffortGuard preserves a SYNCHRONOUS throw from the wrapped runner", () => {
  // The regression this pins: an `async` wrapper converts a synchronous refusal
  // into a rejected promise. The real runner refuses synchronously so a paid eval
  // collected by a foreign test runner cannot bill — a downgrade to "rejects
  // later" is invisible to `assert.throws` and to any caller that does not await.
  const refusing: AgentRunner = () => {
    throw new Error("refused before spending anything");
  };
  assert.throws(
    () => withEffortGuard(refusing)(baseArgs),
    /refused before spending anything/,
  );
});
