/**
 * The machine adapter of core's `ContainerHost` port (vigiles#599): one fresh
 * Docker container per eval attempt, driven through `testcontainers`, and
 * stopped before the attempt's result exists. Stopping the container ends
 * every process the agent started, a `setsid` orphan included, on Linux and
 * macOS alike (#626). The contract is `src/core/container.ts`; the halves are
 * the container's life (`./container-attempt.io.ts`), its image
 * (`./container-image.io.ts`) and the checks before trial 1
 * (`./container-preflight.io.ts`).
 *
 * What this file adds:
 *
 * - `testcontainers` is an optional peer dependency, loaded on first use
 *   through an injected importer, so the default host runner never loads it;
 * - every error `run` throws has the values of the run's env redacted, and so
 *   does a `stop-failed` detail (the env reaches only the exec, where
 *   `docker inspect` does not show it — never the container's config, the
 *   image build or a log line);
 * - a mount Docker would mishandle (missing — Docker would create it as root —
 *   relative, or holding a `:`) is refused before any container starts.
 */
import type {
  ContainerAttempt,
  ContainerHost,
  ContainerPreflight,
  ContainerRunArgs,
} from "../core/container.js";
import {
  attemptIn,
  messageOf,
  runFx,
  withContainer,
  type Tc,
} from "./container-attempt.io.js";
import {
  hostCaOf,
  imageResolver,
  packRunningVigiles,
  type ImageFor,
} from "./container-image.io.js";
import {
  dockerPreflight,
  envPreflight,
  hostMountFinding,
  importFinding,
  mountProblem,
  nodePreflight,
  type PreflightArgs,
} from "./container-preflight.io.js";

export { RUNNER_LABEL } from "./container-attempt.io.js";

/** What the adapter reads from the machine; replaced in tests. */
export interface ContainerHostDeps {
  /** The environment the preflight reads (the Ryuk setting). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This process's Node (`process.versions.node`), asked before testcontainers is loaded. */
  readonly nodeVersion: string;
  /** Loads `testcontainers`; a rejection is `no-testcontainers` or `testcontainers-failed`. */
  readonly importTestcontainers: () => Promise<Tc>;
  /** The bytes of `npm pack` of the running vigiles package. */
  readonly packVigiles: () => Promise<Buffer>;
  /** The host CA a built image trusts, from `NODE_EXTRA_CA_CERTS`; undefined for none. */
  readonly hostCa: () => Readonly<Buffer> | undefined;
}

/** Every env value worth redacting: one under 4 characters is no secret. */
export const secretsOf = (
  env: Readonly<Record<string, string>> | undefined,
): readonly string[] =>
  Object.values(env ?? {})
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);

/** `text` with every secret replaced. */
export const redact = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);

/** `f()`, with every rethrown message and every stop-failed detail cleaned of `secrets`. */
async function scrubbed(
  secrets: readonly string[],
  f: () => Promise<ContainerAttempt>,
): Promise<ContainerAttempt> {
  const attempt = await f().catch((e: unknown) => {
    throw new Error(redact(messageOf(e), secrets));
  });
  return attempt.kind === "stop-failed"
    ? { ...attempt, detail: redact(attempt.detail, secrets) }
    : attempt;
}

/** Throws on the first mount Docker would mishandle. */
function refuseBadMounts(args: ContainerRunArgs): void {
  const bad = args.mounts.find((m) => mountProblem(m) !== undefined);
  if (bad !== undefined)
    throw new Error(
      `container mount ${bad.path}: ${mountProblem(bad) ?? "refused"}`,
    );
}

/** What the adapter is built from: its machine reads and its image memo. */
interface Wired {
  readonly deps: ContainerHostDeps;
  readonly imageFor: ImageFor;
}

async function runAttempt(
  w: Wired,
  args: ContainerRunArgs,
): Promise<ContainerAttempt> {
  refuseBadMounts(args);
  const tc = await w.deps.importTestcontainers();
  const image = await w.imageFor(tc, args.recipe, args.options);
  const s = { tc, image, ...args, why: "attempt" };
  return runFx((fx) => withContainer(fx, s, attemptIn(fx, args)));
}

/** Docker answers, then the image resolves, then the probes in a container. */
async function withDocker(
  w: Wired,
  tc: Readonly<Tc>,
  args: PreflightArgs,
): Promise<ContainerPreflight> {
  const docker = await tc.getContainerRuntimeClient().then(
    () => undefined,
    (e: unknown) => messageOf(e),
  );
  if (docker !== undefined) return { kind: "no-docker", detail: docker };
  return w.imageFor(tc, args.recipe, args.options).then(
    (image) => dockerPreflight(tc, image, args),
    (e: unknown) => ({ kind: "image-failed", detail: messageOf(e) }),
  );
}

async function preflightWith(
  w: Wired,
  args: PreflightArgs,
): Promise<ContainerPreflight> {
  const fromEnv =
    nodePreflight(w.deps.nodeVersion) ??
    envPreflight(w.deps.env) ??
    hostMountFinding(args.mounts);
  if (fromEnv !== undefined) return fromEnv;
  const tc = await w.deps.importTestcontainers().then(
    (loaded) => ({ kind: "loaded", loaded }) as const,
    (e: unknown) => ({ kind: "failed", finding: importFinding(e) }) as const,
  );
  return tc.kind === "failed" ? tc.finding : withDocker(w, tc.loaded, args);
}

/** The adapter, over injectable machine reads. */
export function makeContainerHost(deps: ContainerHostDeps): ContainerHost {
  const w: Wired = {
    deps,
    imageFor: imageResolver({ pack: deps.packVigiles, hostCa: deps.hostCa }),
  };
  return {
    preflight: (args) => preflightWith(w, args),
    run: (args) => scrubbed(secretsOf(args.run.env), () => runAttempt(w, args)),
  };
}

/** The adapter on this machine: `process.env`, the real `testcontainers`, this package's tarball, the host CA. */
export const containerHost: ContainerHost = makeContainerHost({
  env: process.env,
  nodeVersion: process.versions.node,
  importTestcontainers: () => import("testcontainers"),
  packVigiles: packRunningVigiles,
  hostCa: () => hostCaOf(process.env),
});
