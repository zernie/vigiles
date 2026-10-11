/**
 * vigiles — R3 disposable-service tier (⚠️ EXPERIMENTAL / UNSTABLE).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *   EXPERIMENTAL: this surface is a DRAFT. Import it from `vigiles`,
 *   NOT from a stable subpath. It is NOT covered by the stability guarantee and
 *   may change shape or be removed WITHOUT a major-version bump. Do not build a
 *   production workflow on it yet. See docs/measuring-skills.md § Experimental.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS IS. The free tiers (`runHook`, `measureTriggerRate`, `runEval`)
 * cover a skill's OUTPUT and its side-effect SAFETY (did it call / not call a
 * tool, write / not write a file) with no container. What they do NOT do is let
 * a skill actually PERFORM a side effect against a real service and verify the
 * resulting state — apply a migration to a real Postgres and check the row
 * landed. That is the R3 rung (see research/eval-coverage-and-isolation.md): the
 * REAL system's semantics are the thing under test, so it can't be faked.
 *
 * THE POSTURE. vigiles COMPOSES with a throwaway container; it does not reinvent
 * the sandbox. A {@link ServiceSpec} declares a disposable service; the injected
 * {@link ContainerRuntime} port starts it, and it is force-removed on teardown.
 *
 * ⚠️ SAFETY — the isolation is the DISPOSABLE CONTAINER, nothing more. A skill is
 * model-driven, so the MODEL chooses the actions: it can do anything the run
 * ENVIRONMENT allows. vigiles creates and destroys the container; it does NOT, in
 * this tier, confine the skill's filesystem or block its network. So an R3 run is
 * only as safe as the environment you run it in:
 *   - run it in a DISPOSABLE environment — a CI job, a throwaway container/VM, or
 *     a dev box with NO production access;
 *   - point the task at the disposable service's connection string ONLY;
 *   - keep real credentials OUT of the run (prod `DATABASE_URL`, cloud keys,
 *     `~/.ssh`) — pair it with the eval tier's `env: { kind: "ephemeral" }` (throwaway HOME +
 *     cleared env) to scrub them so the model has no real keys to misuse.
 * Treat it like running an untrusted script. A future increment adds an egress
 * wall (the skill reaches only the model + the service); until then that job is
 * the operator's. See docs/measuring-skills.md § Experimental.
 *
 * WHAT SHIPS TODAY vs LATER. Today: the TYPES, the {@link ContainerRuntime} port,
 * the pure {@link experimental_startServices} / {@link experimental_withServices}
 * orchestration, and a Docker backend (`src/services-docker.ts`). Deferred: the
 * `runEval` / `measureArms` `services` option + `ctx.service(name)`, per-trial
 * reset via an eval-loop hook, and the egress wall. Requires Docker (Linux-first).
 * It is an explicit opt-in and NEVER part of `vigiles audit` (audit stays
 * side-effect-free).
 *
 * @experimental
 * @module vigiles (services)
 */

/**
 * How a service signals it is ready to accept work — polled by the
 * {@link ContainerRuntime} before {@link ContainerRuntime.start} resolves, so a
 * consumer never races a half-booted service.
 *
 * @experimental
 */
export type ServiceReady =
  | { readonly tcp: number } // a port accepts a TCP connection
  | { readonly log: RegExp } // a line matches in the container's stdout/stderr
  | { readonly exec: string }; // a command exits 0 inside the container (e.g. `pg_isready`)

/**
 * When a fresh container is provisioned. `"per-trial"` (the DEFAULT) gives each
 * eval trial a clean service so trial N can never observe trial N-1's writes —
 * the repeatability property that makes a side-effecting eval trustworthy.
 * `"per-arm"` shares one container across an arm's trials: faster, but only sound
 * when the task is idempotent or reads only.
 *
 * @experimental
 */
export type ServiceReset = "per-trial" | "per-arm";

/**
 * A disposable service the agent's task may act against — declared per arm/spec
 * on the (future) `services` eval option.
 *
 * @experimental
 */
export interface ServiceSpec {
  /** Container image, e.g. `"postgres:16"` or `"redis:7"`. */
  readonly image: string;
  /** Environment for the container (e.g. `POSTGRES_PASSWORD`). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The port to publish + reach — the one `ServiceHandle.port` reports and
   * `endpoints` lists. v0 supports a SINGLE port (the common disposable-service
   * case: a DB, a cache); multi-port publishing is deferred rather than half-done
   * (a declared-but-unexposed secondary port would be a misleading state).
   */
  readonly port?: number;
  /** Readiness gate — start() resolves only once this passes. */
  readonly ready?: ServiceReady;
  /**
   * A one-shot command run INSIDE the fresh container after it is ready and
   * before the agent runs — e.g. `"psql -U postgres -d app -f schema.sql"`. Its
   * output is recorded once; it is NOT model-synthesized.
   */
  readonly seed?: string;
  /** Provisioning cadence — {@link ServiceReset}. Defaults to `"per-trial"`. */
  readonly reset?: ServiceReset;
}

/**
 * A started service, handed to `measure((ctx) => …)` as `ctx.service(name)` so a
 * check can inspect the REAL resulting state.
 *
 * NOTE: {@link ServiceHandle.exec} is SYNCHRONOUS on purpose — the eval `measure`
 * callback is synchronous (it blocks via `spawnSync`, like `judge()`), so state
 * inspection must be sync too. `exec` is the ONLY inspection primitive by design:
 * it shells the service's own CLI (`psql`, `redis-cli`, …) so vigiles never takes
 * a per-service client dependency.
 *
 * @experimental
 */
export interface ServiceHandle {
  /** Host the agent reaches the service on (from inside the run environment). */
  readonly host: string;
  /** The published host port — `undefined` for a service that exposes none. */
  readonly port?: number;
  /**
   * A connection URL when the runtime can form one; omitted otherwise (build your
   * own from `host` + `port` — the scheme differs per service, so no generic URL).
   */
  readonly url?: string;
  /** Run a command inside the container and read its result (synchronous). */
  exec(command: string): {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
  };
}

/**
 * A live set of started services + the teardown that disposes them. Returned by
 * {@link experimental_startServices}; the caller wires `endpoints` into the run's
 * egress allowlist and maps `handles` into the agent's env / into `measure`.
 *
 * @experimental
 */
export interface ServiceSession {
  /** The started services, keyed by the name declared in the `services` map. */
  readonly handles: Readonly<Record<string, ServiceHandle>>;
  /**
   * `host:port` endpoints for the started services — where to point your task.
   * Intended to ALSO pin an egress allowlist (composing with `src/egress.ts`),
   * but that wall is a FUTURE hardening: the eval tier does NOT apply it today, so
   * right now these just identify the services. Do not read them as a network
   * confinement guarantee — see the SAFETY note in this module's header.
   */
  readonly endpoints: readonly string[];
  /** Stop + remove every started container. Always await this in a `finally`. */
  teardown(): Promise<void>;
}

/**
 * The container-lifecycle PORT — the seam a concrete backend implements (raw
 * `docker` is the planned v0 default; podman / testcontainers / the macOS
 * os-isolation backend swap in by injection, never a conditional). Kept
 * harness-agnostic and dependency-free at the core, exactly like the five
 * harness ports: the abstraction exists so a second backend is a NEW OBJECT, not
 * an edit threaded through the orchestrator.
 *
 * `start` is responsible for HONOURING {@link ServiceSpec.ready} + running
 * {@link ServiceSpec.seed}, so it resolves only with a ready, seeded service.
 *
 * @experimental
 */
export interface ContainerRuntime {
  /** Backend name for diagnostics, e.g. `"docker"`. */
  readonly name: string;
  /** Whether this backend can actually run here (e.g. `docker info` succeeds). */
  available(): boolean | Promise<boolean>;
  /** Provision + ready + seed one service, returning its handle. */
  start(name: string, spec: ServiceSpec): Promise<ServiceHandle>;
  /** Stop + remove a started service. */
  stop(handle: ServiceHandle): Promise<void>;
}

/**
 * Start every declared service against an injected {@link ContainerRuntime},
 * returning a {@link ServiceSession}. Pure orchestration over the port — no
 * `docker` is imported here, so this is fully unit-testable with a fake runtime
 * (the `decideSandbox`-is-pure / `runSandboxed`-is-real split). If any service
 * fails to start, the ones already up are torn down before the error propagates,
 * so a partial failure never leaks a container.
 *
 * A Docker-backed `ContainerRuntime` and the `runEval` / `measureArms` wiring are
 * the next increment — until then this is the primitive you compose by hand:
 * start → pin egress to `session.endpoints` → run → read `session.handles` in
 * `measure` → `await session.teardown()`.
 *
 * @experimental — surface may change without a major-version bump.
 */
export async function experimental_startServices(
  services: Readonly<Record<string, ServiceSpec>>,
  runtime: ContainerRuntime,
): Promise<ServiceSession> {
  const handles: Record<string, ServiceHandle> = {};
  const endpoints: string[] = [];
  const started: ServiceHandle[] = [];
  const stopAll = async (): Promise<void> => {
    await Promise.allSettled(started.map((h) => runtime.stop(h)));
  };
  try {
    for (const [name, spec] of Object.entries(services)) {
      const handle = await runtime.start(name, spec);
      handles[name] = handle;
      started.push(handle);
      // Only a service that published a port has a reachable endpoint.
      if (handle.port !== undefined) {
        endpoints.push(`${handle.host}:${handle.port}`);
      }
    }
  } catch (err) {
    await stopAll();
    throw err;
  }
  return { handles, endpoints, teardown: stopAll };
}

/**
 * Run `fn` with the declared services up, disposing them afterwards — even if
 * `fn` throws. The scope-guard form of {@link experimental_startServices}: it
 * removes the manual `try/finally` so a `measureArms` / `measure` call can be
 * wrapped in one line and its containers are always cleaned up.
 *
 * ⚠️ Read the SAFETY note in this module's header first — the container is the
 * only isolation; keep real credentials out of the run.
 *
 * LIFECYCLE NOTE (honest): the services live for the WHOLE `fn` — i.e. per-RUN,
 * not per-trial. An eval that mutates service state across trials should make its
 * task self-contained (e.g. `drop … if exists; create; migrate`) or run
 * `trials: 1`. True per-trial reset needs an eval-loop hook and is the next
 * increment (research/r3-disposable-services.md).
 *
 * @experimental — surface may change without a major-version bump.
 */
export async function experimental_withServices<T>(
  services: Readonly<Record<string, ServiceSpec>>,
  runtime: ContainerRuntime,
  fn: (session: ServiceSession) => Promise<T>,
): Promise<T> {
  const session = await experimental_startServices(services, runtime);
  try {
    return await fn(session);
  } finally {
    await session.teardown();
  }
}
