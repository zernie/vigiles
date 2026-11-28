/**
 * One container's life for `./container.io.ts` (vigiles#599): start it with
 * only the allowlisted `ContainerOptions`, run one exec in it, and tear it
 * down — stop, remove, then confirm by label that nothing is left — before
 * the result exists.
 *
 * Written in Effect: `acquireUseRelease` holds the container, so the teardown
 * runs on every exit (a defect included); the exec, the deadline and the
 * cancel are raced, and the branch that won — not the exit code 137 a stop
 * also produces — says whether the run timed out, so a cancel is never read
 * as a timeout. Effect stays inside this file: {@link runFx} hands back a
 * plain Promise.
 */
import { randomUUID } from "node:crypto";
import type {
  ContainerAttempt,
  ContainerOptions,
  ContainerRunArgs,
  Mount,
} from "../core/container.js";
import type { RunOut } from "../core/eval-driver.js";

export type Tc = typeof import("testcontainers");
type Fx = typeof import("effect");
type Effect<A, E = never> = Readonly<import("effect").Effect.Effect<A, E>>;
export type Started = import("testcontainers").StartedTestContainer;
type ExecResult = import("testcontainers").ExecResult;
type Builder = import("testcontainers").GenericContainer;

/** The label every container this adapter starts carries; its value says why. */
export const RUNNER_LABEL = "vigiles.container-runner";
/** The label naming one container, so its absence can be confirmed. */
const ATTEMPT_LABEL = "vigiles.attempt";
/** How long a stopped exec may take to hand back what it printed. */
const KILLED_EXEC_GRACE_MS = 15_000;

export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Docker refused or lost a call: thrown, never read as the binary's exit. */
export class TransportError extends Error {
  override readonly name = "ContainerTransportError";
}

/** How an exec ended, without ever rejecting. */
type Settled =
  | { readonly kind: "ok"; readonly result: ExecResult }
  | { readonly kind: "error"; readonly error: unknown };

/** Which branch of the race ended the attempt. */
type Ending =
  | { readonly kind: "exited"; readonly settled: Settled }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

/** A started container and its one teardown (memoised: it runs at most once). */
export interface Held {
  readonly container: Readonly<Started>;
  readonly teardown: Effect<void, Error>;
}

/** What a container is started from. */
export interface StartSpec {
  readonly tc: Readonly<Tc>;
  readonly image: string;
  readonly mounts: readonly Mount[];
  readonly options: ContainerOptions;
  /** The value of {@link RUNNER_LABEL}: `attempt` or `preflight`. */
  readonly why: string;
}

// ── start ───────────────────────────────────────────────────────────────────

type Step = (b: Readonly<Builder>) => Readonly<Builder>;

const when = <T>(
  value: T | undefined,
  step: (v: T) => Step,
): readonly Step[] => (value === undefined ? [] : [step(value)]);

const pullPolicy = (tc: Readonly<Tc>, v: "default" | "always") =>
  v === "always" ? tc.PullPolicy.alwaysPull() : tc.PullPolicy.defaultPolicy();

const ulimitsOf = (u: NonNullable<ContainerOptions["ulimits"]>) =>
  Object.fromEntries(
    Object.entries(u).map(([k, v]) => [k, { hard: v.hard, soft: v.soft }]),
  );

/** Each `ContainerOptions` field as the one builder call it maps to; nothing else is reachable. */
const optionSteps = (
  tc: Readonly<Tc>,
  o: ContainerOptions,
): readonly Step[] => [
  ...when(o.platform, (v) => (b) => b.withPlatform(v)),
  ...when(o.pullPolicy, (v) => (b) => b.withPullPolicy(pullPolicy(tc, v))),
  ...when(o.networkMode, (v) => (b) => b.withNetworkMode(v)),
  ...when(o.resourcesQuota, (v) => (b) => b.withResourcesQuota({ ...v })),
  ...when(o.sharedMemorySize, (v) => (b) => b.withSharedMemorySize(v)),
  ...when(o.ulimits, (v) => (b) => b.withUlimits(ulimitsOf(v))),
  ...when(
    o.extraHosts,
    (v) => (b) => b.withExtraHosts(v.map((h) => ({ ...h }))),
  ),
  ...when(o.tmpFs, (v) => (b) => b.withTmpFs({ ...v })),
  ...when(o.droppedCapabilities, (v) => (b) => b.withDroppedCapabilities(...v)),
];

const hostUser = (): string => {
  if (process.getuid === undefined || process.getgid === undefined)
    throw new Error("the container runner needs a POSIX host (uid:gid)");
  return `${String(process.getuid())}:${String(process.getgid())}`;
};

/** A fresh container: the mounts at their own paths, the host's uid:gid, idle until exec. */
async function startContainer(
  s: StartSpec,
): Promise<{ readonly c: Started; readonly id: string }> {
  const id = randomUUID();
  const base = new s.tc.GenericContainer(s.image)
    .withCommand(["sleep", "infinity"])
    .withBindMounts(
      s.mounts.map((m) => ({ source: m.path, target: m.path, mode: m.mode })),
    )
    .withUser(hostUser())
    .withLabels({ [RUNNER_LABEL]: s.why, [ATTEMPT_LABEL]: id });
  const builder = optionSteps(s.tc, s.options).reduce<Readonly<Builder>>(
    (b, step) => step(b),
    base,
  );
  return { c: await builder.start(), id };
}

// ── teardown ────────────────────────────────────────────────────────────────

/**
 * Stop and remove, then confirm by label that no container is left. The
 * listing decides: a stop that errors on a container already gone is still
 * a confirmed teardown, and a clean stop of one still listed is not.
 */
async function teardownOf(
  tc: Readonly<Tc>,
  c: Readonly<Started>,
  id: string,
): Promise<void> {
  const client = await tc.getContainerRuntimeClient();
  const why = await c
    .stop({ timeout: 0, remove: false })
    .then(() => client.container.remove(client.container.getById(c.getId())))
    .then(() => "removed, yet listed", messageOf);
  const left = await client.container.dockerode.listContainers({
    all: true,
    filters: { label: [`${ATTEMPT_LABEL}=${id}`] },
  });
  if (left.length > 0)
    throw new Error(`container ${c.getId()} is still there: ${why}`);
}

/** Start one container and memoise its teardown; the release runs it if `use` did not. */
export function withContainer<A>(
  fx: Readonly<Fx>,
  s: StartSpec,
  use: (h: Held) => Effect<A, Error>,
): Effect<A, Error> {
  const { Effect } = fx;
  const acquire = Effect.gen(function* () {
    const { c, id } = yield* Effect.tryPromise({
      try: () => startContainer(s),
      catch: (e) =>
        new TransportError(`container start failed: ${messageOf(e)}`),
    });
    const teardown = yield* Effect.cached(
      Effect.tryPromise({
        try: () => teardownOf(s.tc, c, id),
        catch: (e) => new Error(messageOf(e)),
      }),
    );
    return { container: c, teardown };
  });
  return Effect.acquireUseRelease(acquire, use, (h) =>
    Effect.ignore(h.teardown),
  );
}

// ── one attempt ─────────────────────────────────────────────────────────────

const settle = (p: Promise<ExecResult>): Promise<Settled> =>
  p.then(
    (result): Settled => ({ kind: "ok", result }),
    (error: unknown): Settled => ({ kind: "error", error }),
  );

/** Resolves when `signal` fires (at once if it already has); never without one. */
const abortOf = (
  fx: Readonly<Fx>,
  signal: Readonly<AbortSignal> | undefined,
): Effect<Ending> =>
  signal === undefined
    ? fx.Effect.never
    : fx.Effect.callback<Ending>((resume) => {
        const fire = (): void => {
          resume(fx.Effect.succeed({ kind: "cancelled" }));
        };
        if (signal.aborted) fire();
        else signal.addEventListener("abort", fire, { once: true });
        return fx.Effect.sync(() => {
          signal.removeEventListener("abort", fire);
        });
      });

/** The exec, the deadline and the cancel, raced: the first to end decides. */
const endingOf = (
  fx: Readonly<Fx>,
  exec: Promise<Settled>,
  run: ContainerRunArgs["run"],
): Effect<Ending> =>
  fx.Effect.raceAll([
    fx.Effect.map(
      fx.Effect.promise(() => exec),
      (settled): Ending => ({ kind: "exited", settled }),
    ),
    fx.Effect.as(fx.Effect.sleep(run.timeoutMs), { kind: "timeout" } as const),
    abortOf(fx, run.signal),
  ]);

/** A run this adapter killed: no exit code, the signal named, like the host runner. */
const killedOut = (
  late: Settled | undefined,
  timedOut: boolean,
): Readonly<RunOut> => {
  const r = late?.kind === "ok" ? late.result : undefined;
  return {
    code: -1,
    stdout: r?.stdout ?? "",
    stderr: r?.stderr ?? "",
    signal: "SIGKILL",
    ...(timedOut ? { timedOut: true } : {}),
  };
};

/** Stop the container, then take what the stopped exec printed. */
const killed = (
  fx: Readonly<Fx>,
  h: Held,
  exec: Promise<Settled>,
): ((timedOut: boolean) => Effect<RunOut>) => {
  const stop = fx.Effect.ignore(
    fx.Effect.tryPromise(() => h.container.stop({ timeout: 0, remove: false })),
  );
  const late = fx.Effect.timeoutOption(
    fx.Effect.promise(() => exec),
    KILLED_EXEC_GRACE_MS,
  );
  return (timedOut) =>
    fx.Effect.map(fx.Effect.andThen(stop, late), (o) =>
      killedOut(o._tag === "Some" ? o.value : undefined, timedOut),
    );
};

/** The exit of a finished exec: its own code. A failed exec is a transport error. */
const exitedOut = (fx: Readonly<Fx>, s: Settled): Effect<RunOut, Error> =>
  s.kind === "ok"
    ? fx.Effect.succeed({
        code: s.result.exitCode,
        stdout: s.result.stdout,
        stderr: s.result.stderr,
      })
    : fx.Effect.fail(new TransportError(`exec failed: ${messageOf(s.error)}`));

const outOf = (
  fx: Readonly<Fx>,
  h: Held,
  exec: Promise<Settled>,
): ((ending: Ending) => Effect<RunOut, Error>) => {
  const kill = killed(fx, h, exec);
  return (ending) => {
    switch (ending.kind) {
      case "exited":
        return exitedOut(fx, ending.settled);
      case "timeout":
        return kill(true);
      case "cancelled":
        return kill(false);
    }
  };
};

/** `recipe.binary argv…` in the held container, ended by itself, the deadline or a cancel; then torn down. */
export const attemptIn =
  (fx: Readonly<Fx>, args: ContainerRunArgs) =>
  (h: Held): Effect<ContainerAttempt, Error> =>
    fx.Effect.gen(function* () {
      const exec = yield* fx.Effect.sync(() =>
        settle(
          h.container.exec([args.recipe.binary, ...args.argv], {
            env: { ...args.run.env },
            workingDir: args.run.cwd,
          }),
        ),
      );
      const ending = yield* endingOf(fx, exec, args.run);
      const out = yield* outOf(fx, h, exec)(ending);
      const down = yield* fx.Effect.result(h.teardown);
      return down._tag === "Success"
        ? { kind: "ran" as const, out }
        : { kind: "stop-failed" as const, out, detail: down.failure.message };
    });

/** Run an Effect to a plain Promise, rejecting with the program's own error. */
export async function runFx<A>(
  build: (fx: Readonly<Fx>) => Effect<A, Error>,
): Promise<A> {
  const fx = await import("effect");
  const exit = await fx.Effect.runPromiseExit(build(fx));
  if (fx.Exit.isSuccess(exit)) return exit.value;
  throw fx.Cause.squash(exit.cause);
}
