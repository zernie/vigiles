/**
 * The checks `./container.io.ts` runs once before trial 1 (vigiles#599), each
 * ending in the `ContainerPreflight` kind whose cure the user can act on:
 * the environment first (Ryuk turned off), then Docker itself, then, from
 * inside a container started the way a run's is, the image, the network the
 * harness needs (a request to the recipe's `egressProbe` URL with the image's
 * own `node`, so a proxy, its CA and the network mode are all asked rather
 * than guessed from a variable's text), and a round trip through every mount.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CONTAINER_VIGILES_CLI,
  type ContainerHost,
  type ContainerPreflight,
  type HarnessImageRecipe,
  type Mount,
} from "../core/container.js";
import {
  messageOf,
  runFx,
  withContainer,
  type Started,
  type StartSpec,
  type Tc,
} from "./container-attempt.io.js";

export type PreflightArgs = Parameters<ContainerHost["preflight"]>[0];
type Env = Readonly<Record<string, string | undefined>>;
type Finding = ContainerPreflight | undefined;

/** How long the egress probe waits for an answer before it calls the URL unreachable. */
const EGRESS_TIMEOUT_MS = 15_000;

const truthy = (value: string | undefined): boolean =>
  ["true", "1", "yes"].includes((value ?? "").trim().toLowerCase());

/** The checks that need no Docker: the environment the container would run under. */
export function envPreflight(env: Env): Finding {
  return truthy(env.TESTCONTAINERS_RYUK_DISABLED)
    ? { kind: "ryuk-disabled" }
    : undefined;
}

/**
 * Why a mount cannot be handed to Docker as-is, if it cannot. Docker CREATES
 * a missing bind source (as root), and `:` or `,` would split the bind spec.
 */
export function mountProblem(m: Mount): string | undefined {
  if (!isAbsolute(m.path)) return "not an absolute path";
  if (/[:,]/.test(m.path)) return "a ':' or ',' in the path";
  return existsSync(m.path) ? undefined : "does not exist on this machine";
}

/** The first mount that cannot be handed to Docker, checked here before any container. */
export const hostMountFinding = (mounts: readonly Mount[]): Finding => {
  const bad = mounts.find((m) => mountProblem(m) !== undefined);
  return bad === undefined
    ? undefined
    : { kind: "mount-failed", path: bad.path, detail: mountProblem(bad) ?? "" };
};

/** What a probe container is asked about one mount. */
const probeArgv = (m: Mount, nonce: string): readonly string[] =>
  m.mode === "ro"
    ? ["sh", "-c", 'test -r "$1" && ls "$1" >/dev/null', "probe", m.path]
    : [
        "sh",
        "-c",
        'p="$1/.vigiles-probe-$2" && printf "#!/bin/sh\\necho ok-$2\\n" > "$p" && chmod +x "$p" && "$p" > "$p.out"',
        "probe",
        m.path,
        nonce,
      ];

/** Whether a rw mount's probe wrote back what it ran; removes both probe files. */
const probeCameBack = (m: Mount, nonce: string): boolean => {
  const p = `${m.path}/.vigiles-probe-${nonce}`;
  try {
    return (
      existsSync(`${p}.out`) &&
      readFileSync(`${p}.out`, "utf8").trim() === `ok-${nonce}`
    );
  } finally {
    rmSync(p, { force: true });
    rmSync(`${p}.out`, { force: true });
  }
};

/** A mount round trip: written, made executable and run inside, read back here. */
async function probeMount(c: Readonly<Started>, m: Mount): Promise<Finding> {
  const nonce = randomUUID().slice(0, 8);
  const r = await c.exec([...probeArgv(m, nonce)]);
  const ok = r.exitCode === 0 && (m.mode === "ro" || probeCameBack(m, nonce));
  if (ok) return undefined;
  const why = r.stderr.trim() || "the probe file did not come back";
  return {
    kind: "mount-failed",
    path: m.path,
    detail: `exit ${String(r.exitCode)}: ${why}`,
  };
}

/** The image holds the binary and vigiles's CLI where a run looks for them. */
async function probeImage(
  c: Readonly<Started>,
  recipe: HarnessImageRecipe,
): Promise<Finding> {
  const r = await c.exec([
    "sh",
    "-c",
    'command -v "$1" >/dev/null || { echo "no $1 on PATH" >&2; exit 1; }; ' +
      'test -f "$2" || { echo "no vigiles CLI at $2" >&2; exit 1; }',
    "probe",
    recipe.binary,
    CONTAINER_VIGILES_CLI,
  ]);
  return r.exitCode === 0
    ? undefined
    : { kind: "image-failed", detail: r.stderr.trim() };
}

/**
 * Requests `process.argv[1]` and exits 0 on ANY HTTP status (the server
 * answered); on a network or TLS failure prints the error's code (the
 * `cause` of fetch's "fetch failed"), else its message, and exits 1.
 */
const EGRESS_SCRIPT =
  "fetch(process.argv[1], { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(Number(process.argv[2])) })" +
  ".then(() => process.exit(0), (e) => { const c = e.cause ?? e; " +
  "console.error(typeof c.code === 'string' ? c.code : String(c.message || c.name || c)); process.exit(1); });";

/** The harness's network, asked: the recipe's URL requested with the image's `node`, under the image's env. */
async function probeEgress(
  c: Readonly<Started>,
  recipe: HarnessImageRecipe,
): Promise<Finding> {
  const url = recipe.egressProbe;
  if (url === undefined) return undefined;
  const r = await c.exec([
    "node",
    "-e",
    EGRESS_SCRIPT,
    url,
    String(EGRESS_TIMEOUT_MS),
  ]);
  if (r.exitCode === 0) return undefined;
  const detail = r.stderr.trim() || `exit ${String(r.exitCode)}`;
  return { kind: "no-egress", url, detail };
}

async function probeAll(
  c: Readonly<Started>,
  args: PreflightArgs,
): Promise<ContainerPreflight> {
  const image = await probeImage(c, args.recipe);
  if (image !== undefined) return image;
  const egress = await probeEgress(c, args.recipe);
  if (egress !== undefined) return egress;
  const found = await Promise.all(args.mounts.map((m) => probeMount(c, m)));
  return found.find((f) => f !== undefined) ?? { kind: "ready" };
}

/** Start a container like a run's, `use` it, tear it down. */
const inContainer = <A>(
  s: StartSpec,
  use: (c: Readonly<Started>) => Promise<A>,
): Promise<A> =>
  runFx((fx) =>
    withContainer(fx, s, (h) =>
      fx.Effect.tryPromise({
        try: () => use(h.container),
        catch: (e) => new Error(messageOf(e)),
      }),
    ),
  );

/** A start that failed with every mount: the first mount that fails alone is the cause, else the image is. */
async function startFailure(
  s: StartSpec,
  error: unknown,
): Promise<ContainerPreflight> {
  const alone = await Promise.all(
    s.mounts.map((m) =>
      inContainer({ ...s, mounts: [m] }, () => Promise.resolve()).then(
        () => undefined,
        (e: unknown) => ({ m, e }),
      ),
    ),
  );
  const culprit = alone.find((a) => a !== undefined);
  return culprit === undefined
    ? { kind: "image-failed", detail: messageOf(error) }
    : {
        kind: "mount-failed",
        path: culprit.m.path,
        detail: messageOf(culprit.e),
      };
}

/** Every Docker-side check, in a container started like a run's. */
export async function dockerPreflight(
  tc: Readonly<Tc>,
  image: string,
  args: PreflightArgs,
): Promise<ContainerPreflight> {
  const s: StartSpec = { tc, image, ...args, why: "preflight" };
  return inContainer(s, (c) => probeAll(c, args)).catch((e: unknown) =>
    startFailure(s, e),
  );
}
