/**
 * `env: { kind: "docker" }` (vigiles#599) through the trial pipeline
 * of `./eval.ts`, driven by `runEvalWith` against a FAKE `ContainerHost` — no
 * Docker. What the fake records is what the real adapter would be asked: one
 * `run` per attempt, after the attempt's world is reset; a preflight before
 * trial 1; nothing on a cache hit; no score, cache entry or lock from an
 * attempt whose container could not be confirmed stopped.
 */
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  registerAgentVersion,
  runEvalReporting,
  runEvalWith,
  type EvalSpec,
} from "./eval.js";
import { ContainerRefusalError } from "./eval-container.js";
import { HOST_CONTAINMENT_LINE } from "./eval-container-attempt.js";
import {
  CONTAINER_VIGILES_CLI,
  type ContainerAttempt,
  type ContainerHost,
  type ContainerPreflight,
  type ContainerRunArgs,
  type Mount,
} from "./core/container.js";
import type { AgentRunner, RunOut } from "./core/eval-driver.js";
import type { EvalHost } from "./core/eval-host.js";
import { stubPaths } from "./core/stub-rules.js";
import { makeTmpDir } from "./core/test-utils.js";
import { evalHost } from "./host/workspace-host.io.js";
import { lockPath, readLock } from "./eval-lock.js";
import { experimental_stub } from "./stub.js";

const MODEL = "claude-sonnet-4-6-20260101";
const VERSION = "2.1.300";

const RESULT: RunOut = {
  code: 0,
  stdout: JSON.stringify({ type: "result", result: "ok", num_turns: 1 }),
};
const LIMITED: RunOut = {
  code: 1,
  stdout: JSON.stringify({
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    api_error_type: "rate_limit_error",
  }),
};

/** The injected runner a container run must never call; it carries the host binary's version. */
function hostRunner(): { readonly run: AgentRunner; calls: () => number } {
  let calls = 0;
  const run: AgentRunner = () => {
    calls += 1;
    return Promise.resolve(RESULT);
  };
  registerAgentVersion(run, () => `${VERSION} (agent)\n`);
  return { run, calls: () => calls };
}

interface Fake {
  readonly port: ContainerHost;
  readonly log: string[];
  readonly runs: ContainerRunArgs[];
  readonly preflights: (readonly Mount[])[];
}

/** A fake container host: answers the preflight, and each `run` from `attempt(n)`. */
function fakeContainer(
  attempt: (n: number, args: ContainerRunArgs) => ContainerAttempt = () => ({
    kind: "ran",
    out: RESULT,
  }),
  preflight: ContainerPreflight = { kind: "ready" },
): Fake {
  const log: string[] = [];
  const runs: ContainerRunArgs[] = [];
  const preflights: (readonly Mount[])[] = [];
  return {
    log,
    runs,
    preflights,
    port: {
      preflight: (a) => {
        log.push("preflight");
        preflights.push(a.mounts);
        return Promise.resolve(preflight);
      },
      run: (a) => {
        log.push("run");
        runs.push(a);
        return Promise.resolve(attempt(runs.length, a));
      },
    },
  };
}

const hostWith = (port: ContainerHost): EvalHost => ({
  ...evalHost,
  engineFingerprint: () => ({ kind: "found", hash: "e1" }),
  container: port,
});

type Spec = Extract<
  EvalSpec,
  { readonly arms: object; readonly measure: object }
>;

const spec = (extra: Partial<Spec> = {}): Spec => ({
  name: "box",
  env: { kind: "docker" },
  arms: { a: { files: { "x.txt": "1" } } },
  task: "do it",
  trials: 1,
  model: MODEL,
  spacingSec: 0,
  experimental_contextCheck: false,
  measure: () => ({ ok: true }),
  ...extra,
});

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

// --- the pipeline, through runEvalWith ----------------------------------------

test("each attempt is one container run, after the preflight, never the injected runner", async () => {
  const fake = fakeContainer();
  const host = hostRunner();
  const report = await runEvalWith(
    spec({ trials: 2 }),
    host.run,
    hostWith(fake.port),
  );
  // Guards: one preflight before trial 1, then one `run` per attempt.
  assert.deepEqual(fake.log, ["preflight", "run", "run"]);
  // Guards: a container run never falls back to the host runner.
  assert.equal(host.calls(), 0);
  // Guards: both trials were scored from the container's output.
  assert.equal(report.arms.a?.runs, 2);
  // Guards: the report names the image the attempts ran in.
  assert.equal(report.containment?.kind, "container");
});

test("the preflight is asked with the mounts trial 1 uses: work dir and HOME read-write", async () => {
  const fake = fakeContainer();
  await runEvalWith(spec(), hostRunner().run, hostWith(fake.port));
  const [probe = []] = fake.preflights;
  const [attempt] = fake.runs;
  // Guards: the preflight tests a mount of each kind the attempt makes.
  assert.deepEqual(
    probe.map((m) => m.mode),
    attempt?.mounts.map((m) => m.mode),
  );
  // Guards: the attempt mounts its own work dir and HOME, writable.
  assert.deepEqual(attempt?.mounts, [
    { path: attempt?.run.cwd, mode: "rw" },
    { path: attempt?.run.env?.HOME, mode: "rw" },
  ]);
});

test("a rate-limited attempt is retried in a NEW container, after its stub log was reset", async () => {
  const GH = experimental_stub("gh", [
    { argv: ["x"], reply: { kind: "always", stdout: "y" } },
  ]);
  const logAtStart: boolean[] = [];
  const fake = fakeContainer((n, a) => {
    const root = a.mounts.find((m) =>
      existsSync(stubPaths(m.path).rulesDir),
    )?.path;
    const log = stubPaths(root ?? "").log;
    logAtStart.push(existsSync(log));
    // The discarded attempt leaves a call behind; the retry must not see it.
    writeFileSync(log, "");
    return { kind: "ran", out: n === 1 ? LIMITED : RESULT };
  });
  await runEvalWith(
    spec({ stubs: [GH], rateLimitRetries: 1, retryBackoffMs: 0 }),
    hostRunner().run,
    hostWith(fake.port),
  );
  // Guards: the retry is its own container, never the limited one re-used.
  assert.equal(fake.runs.length, 2);
  // Guards: `beforeAttempt` ran before EACH run — the retry started with the
  // discarded attempt's log gone.
  assert.deepEqual(logAtStart, [false, false]);
});

test("a cache hit replays without asking the container host to run anything", async () => {
  const cacheDir = makeTmpDir("box-cache");
  const first = fakeContainer();
  await runEvalWith(
    spec({ cache: "readwrite", cacheDir }),
    hostRunner().run,
    hostWith(first.port),
  );
  const second = fakeContainer();
  const replay = await runEvalWith(
    spec({ cache: "read", cacheDir }),
    hostRunner().run,
    hostWith(second.port),
  );
  // Guards: the first run recorded its attempt.
  assert.equal(first.runs.length, 1);
  // Guards: the replay started no container.
  assert.equal(second.runs.length, 0);
  // Guards: and still scored the trial from the record.
  assert.equal(replay.arms.a?.runs, 1);
});

test("a host run's cache record is never replayed into a container run", async () => {
  const cacheDir = makeTmpDir("box-cache");
  await runEvalWith(
    spec({
      env: { kind: "local", inherit: "none" },
      cache: "readwrite",
      cacheDir,
    }),
    hostRunner().run,
  );
  const fake = fakeContainer();
  await runEvalWith(
    spec({ cache: "read", cacheDir }),
    hostRunner().run,
    hostWith(fake.port),
  );
  // Guards: the container attempt's key carries its container, so the host
  // record misses and the attempt runs in a container.
  assert.equal(fake.runs.length, 1);
});

test("an attempt whose container could not be confirmed stopped is never scored, cached or locked", async () => {
  const cacheDir = makeTmpDir("box-cache");
  const lockDir = makeTmpDir("box-lock");
  const fake = fakeContainer(() => ({
    kind: "stop-failed",
    out: RESULT,
    detail: "daemon gone",
  }));
  const run = runEvalWith(
    spec({
      cache: "readwrite",
      cacheDir,
      lock: { mode: "update", dir: lockDir, evalApiVersion: 1 },
    }),
    hostRunner().run,
    hostWith(fake.port),
  );
  // Guards: the run fails loudly instead of returning a report.
  await assert.rejects(run, /could not be confirmed stopped/);
  // Guards: nothing was recorded for a replay to serve later.
  assert.deepEqual(filesUnder(cacheDir), []);
  // Guards: no lock was written from the unscored attempt.
  assert.equal(existsSync(lockPath(lockDir, "box")), false);
});

test("a hook that could not run in the image (exit 126/127) refuses the attempt loudly", async () => {
  for (const code of [126, 127]) {
    const hookLine = JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Bash",
      hook_event: "PreToolUse",
      exit_code: code,
      output: "sh: 1: jq: not found",
    });
    const fake = fakeContainer(() => ({
      kind: "ran",
      out: { code: 0, stdout: `${hookLine}\n${RESULT.stdout}` },
    }));
    // Guards: an attempt that measured a harness without its hook is not scored.
    await assert.rejects(
      runEvalWith(spec(), hostRunner().run, hostWith(fake.port)),
      new RegExp(`hook could not run \\(exit ${String(code)}\\)`),
    );
  }
});

test("a preflight that is not ready stops the run before trial 1, with its one line", async () => {
  const fake = fakeContainer(undefined, {
    kind: "no-docker",
    detail: "connect ENOENT /var/run/docker.sock",
  });
  const run = runEvalWith(spec(), hostRunner().run, hostWith(fake.port));
  // Guards: the refusal names Docker and its cure, as one refusal.
  await assert.rejects(
    run,
    (err: unknown) =>
      err instanceof ContainerRefusalError &&
      err.message.startsWith(
        'env: { kind: "docker" } needs Docker, and no Docker daemon answered. ' +
          "Start Docker Desktop (macOS) or the docker service (Linux), then re-run.",
      ),
  );
  // Guards: no trial started.
  assert.deepEqual(fake.log, ["preflight"]);
});

test("a container attempt gets the image's PATH plus the stub dir, and calls the image's vigiles", async () => {
  const GH = experimental_stub("gh", [
    { argv: ["x"], reply: { kind: "always", stdout: "y" } },
  ]);
  let shim = "";
  let settings = "";
  let stubRoot = "";
  const fake = fakeContainer((_n, a) => {
    stubRoot =
      a.mounts.find((m) => existsSync(stubPaths(m.path).rulesDir))?.path ?? "";
    const bin = a.run.env?.PATH ?? "";
    shim = readFileSync(join(bin, "gh"), "utf8");
    settings = readFileSync(join(a.run.cwd, "settings.json"), "utf8");
    return { kind: "ran", out: RESULT };
  });
  await runEvalWith(
    spec({
      stubs: [GH],
      arms: { a: { interceptTools: [{ tool: "Bash" }] } },
    }),
    hostRunner().run,
    hostWith(fake.port),
  );
  const [attempt] = fake.runs;
  // Guards: the stub root is mounted, so the shims can log their calls.
  assert.notEqual(stubRoot, "");
  // Guards: the host's PATH names host dirs the image lacks: only the stub
  // bin dir travels, for the container host to put before the image's PATH.
  assert.equal(attempt?.run.env?.PATH, stubPaths(stubRoot).binDir);
  // Guards: the container gets a complete env, never an overlay on the host's.
  assert.equal(attempt?.run.replaceEnv, true);
  // Guards: a stub shim calls the vigiles inside the image, not the host's.
  assert.ok(shim.includes(CONTAINER_VIGILES_CLI));
  // Guards: so does the auto-wired intercept hook.
  assert.ok(settings.includes(CONTAINER_VIGILES_CLI));
});

test("a container run's lock inputs differ from the host's, and between two option sets", async () => {
  const hashOf = async (extra: Partial<Spec>): Promise<string> => {
    const dir = makeTmpDir("box-lock");
    await runEvalWith(
      spec({ lock: { mode: "update", dir, evalApiVersion: 1 }, ...extra }),
      hostRunner().run,
      hostWith(fakeContainer().port),
    );
    return readLock(dir, "box")?.inputsHash ?? "";
  };
  const host = await hashOf({ env: { kind: "local", inherit: "none" } });
  const box = await hashOf({});
  const offline = await hashOf({
    env: { kind: "docker", networkMode: "none" },
  });
  // Guards: a host lock never vouches for a container run, or the reverse.
  assert.notEqual(host, box);
  // Guards: an option that changes what the agent reaches is a new input.
  assert.notEqual(box, offline);
});

test("a host run says once per run what it cannot end; a container run says nothing", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const host = await runEvalReporting(
      spec({ env: { kind: "local", inherit: "none" }, trials: 2 }),
      hostRunner().run,
    );
    const said = errors.mock.calls.filter(
      ([line]) => line === `ℹ runEval: ${HOST_CONTAINMENT_LINE}`,
    );
    // Guards: the report records that nothing contained the attempts.
    assert.deepEqual(host.containment, { kind: "none", why: "host-runner" });
    // Guards: one line per run, never one per trial.
    assert.equal(said.length, 1);
    errors.mockClear();
    await runEvalReporting(
      spec(),
      hostRunner().run,
      hostWith(fakeContainer().port),
    );
    // Guards: a contained run has nothing to warn about.
    assert.ok(
      !errors.mock.calls.some(
        ([line]) => line === `ℹ runEval: ${HOST_CONTAINMENT_LINE}`,
      ),
    );
  } finally {
    errors.mockRestore();
  }
});

test("a container env's seed is laid into the HOME the attempt mounts", async () => {
  let seeded = "";
  const fake = fakeContainer((_n, a) => {
    seeded = readFileSync(join(a.run.env?.HOME ?? "", ".gitconfig"), "utf8");
    return { kind: "ran", out: RESULT };
  });
  await runEvalWith(
    spec({
      env: {
        kind: "docker",
        home: { kind: "files", files: { ".gitconfig": "[user]\n" } },
      },
    }),
    hostRunner().run,
    hostWith(fake.port),
  );
  // Guards: `home` seeds a container's throwaway HOME the same way it seeds an
  // ephemeral one, so the two kinds differ only in where the process runs.
  assert.equal(seeded, "[user]\n");
});

test('an `execution` key is refused before trial 1, pointing at env: { kind: "docker" }', async () => {
  const fake = fakeContainer();
  const host = hostRunner();
  // As a plain-JS eval file would write it; TypeScript refuses the key itself.
  const raw = {
    ...spec({ env: { kind: "local", inherit: "none" } }),
    execution: { kind: "container" },
  };
  const run = runEvalWith(raw, host.run, hostWith(fake.port));
  // Guards: a container asked for under any other key never runs on the host
  // in silence: the unknown field is refused and names the spelling that works.
  await assert.rejects(
    run,
    /unknown EvalSpec field "execution" — where an attempt runs is `env`; env: \{ kind: "docker" \}/,
  );
  // Guards: refused before anything ran, here or in a container.
  assert.equal(host.calls(), 0);
  assert.deepEqual(fake.log, []);
});
