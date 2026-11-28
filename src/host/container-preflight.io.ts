/**
 * The checks `./container.io.ts` runs once before trial 1 (vigiles#599), each
 * ending in the `ContainerPreflight` kind whose cure the user can act on:
 * the environment first (Ryuk turned off, a proxy on this machine that a
 * container cannot reach), then Docker itself, the image, and a round trip
 * through every mount from inside a container started the way a run's is.
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

/** The variables a proxy is read from, in the order they are checked. */
const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const isLoopback = (hostname: string): boolean =>
  ["localhost", "[::1]", "0.0.0.0"].includes(hostname) ||
  hostname.startsWith("127.");

const proxyHost = (value: string): string | undefined => {
  const withScheme = value.includes("://") ? value : `http://${value}`;
  return URL.canParse(withScheme) ? new URL(withScheme).hostname : undefined;
};

/** The first proxy variable that points at this machine, which a container cannot reach. */
export function localhostProxyVariable(env: Env): string | undefined {
  return PROXY_VARIABLES.find((name) => {
    const host = proxyHost(env[name] ?? "");
    return host !== undefined && isLoopback(host);
  });
}

const truthy = (value: string | undefined): boolean =>
  ["true", "1", "yes"].includes((value ?? "").trim().toLowerCase());

/** The checks that need no Docker: the environment the container would run under. */
export function envPreflight(env: Env): Finding {
  if (truthy(env.TESTCONTAINERS_RYUK_DISABLED))
    return { kind: "ryuk-disabled" };
  const variable = localhostProxyVariable(env);
  return variable === undefined
    ? undefined
    : { kind: "localhost-proxy", variable };
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

async function probeAll(
  c: Readonly<Started>,
  args: PreflightArgs,
): Promise<ContainerPreflight> {
  const image = await probeImage(c, args.recipe);
  if (image !== undefined) return image;
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
