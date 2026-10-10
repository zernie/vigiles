/**
 * The environment a child agent run inherits — the one place the runners turn
 * a caller's `process.env` into a spawn env.
 *
 * Two shapes, both driven by the harness's declared {@link RunEnvPolicy}:
 *
 * - SCRUBBED (`scrubbedRunEnv`): a throwaway HOME/TMPDIR, the OS essentials, the
 *   harness's declared auth, and the caller's own named extras. Everything else
 *   is dropped. The eval tier's `env: { kind: "ephemeral" }` and the harness-tier preflight of
 *   `experimental_outputStyleArms` use it.
 * - INHERITED (`withoutSessionIdentity`): the caller's env as-is, minus the
 *   harness's declared session identity. The default spawn of both tiers.
 *
 * In both, the parent session's identity never reaches the child. The core
 * names no harness: which variables are auth and which are identity is the
 * adapter's declaration.
 *
 * Pure — no fs, no spawn.
 */
import type { RunEnvPolicy } from "./runtime.js";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * What ANY spawned process needs to function, whatever the harness: resolve
 * binaries (`PATH`) and keep the locale and terminal (`LANG`, `LC_*`, `TERM`).
 * Mirrors what `bwrapArgs` sets back after `--clearenv` in `src/sandbox.ts`.
 */
export const OS_ESSENTIAL_ENV: readonly string[] = ["PATH", "LANG", "TERM"];
const OS_ESSENTIAL_PREFIXES: readonly string[] = ["LC_"];

/**
 * Build a SCRUBBED run environment: a NEW env with `HOME`/`TMPDIR` set to the
 * throwaway `opts.home`, the {@link OS_ESSENTIAL_ENV}, the harness's
 * `policy.keep`, and the caller's `opts.allow`, taken from `base`. Everything
 * else is dropped, and `policy.sessionIdentity` is dropped even when listed in
 * `keep` or `allow`.
 *
 * Without a policy only the essentials pass: right for a run against a scripted
 * mock, which needs no auth.
 */
export function scrubbedRunEnv(
  base: EnvLike,
  opts: {
    readonly home: string;
    readonly policy?: RunEnvPolicy;
    readonly allow?: readonly string[];
  },
): Readonly<Record<string, string>> {
  const identity = new Set(opts.policy?.sessionIdentity ?? []);
  const exact = new Set([
    ...OS_ESSENTIAL_ENV,
    ...(opts.policy?.keep ?? []),
    ...(opts.allow ?? []),
  ]);
  const passes = (k: string): boolean =>
    !identity.has(k) &&
    (exact.has(k) || OS_ESSENTIAL_PREFIXES.some((p) => k.startsWith(p)));
  return {
    ...defined(base, passes),
    // Last, so they win over anything passed through.
    HOME: opts.home,
    TMPDIR: opts.home,
  };
}

/**
 * The caller's env with the harness's declared session identity removed — the
 * INHERITED shape. Unset (`undefined`) values are dropped too, so the result is
 * a plain spawn env. Without a policy nothing is removed.
 */
export function withoutSessionIdentity(
  base: EnvLike,
  policy?: RunEnvPolicy,
): Readonly<Record<string, string>> {
  const identity = new Set(policy?.sessionIdentity ?? []);
  return defined(base, (k) => !identity.has(k));
}

function defined(
  base: EnvLike,
  keep: (name: string) => boolean,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(base).filter(
      (e): e is [string, string] => e[1] !== undefined && keep(e[0]),
    ),
  );
}

// --- the run environment a spec declares ----------------------------------------

/** Files to write under a throwaway HOME: HOME-relative POSIX path → contents. */
export type HomeFiles = Readonly<Record<string, string>>;

/**
 * Where a throwaway HOME's starting contents come from. A FILE map, so an empty
 * directory cannot be expressed — Claude Code's startup housekeeping removes
 * empty task directories, and a seed that could hold one would lose it.
 */
export interface HomeSeed {
  readonly kind: "files";
  readonly files: HomeFiles;
}

/**
 * Where a run executes. Two cases, and `home` exists only on `ephemeral`: there
 * is no way to write "seed my real HOME".
 *
 * - `ephemeral` — a throwaway HOME (seeded from `home`, then given the
 *   harness's own auth files) and a scrubbed environment.
 * - `inherit` — your real HOME and environment, minus the parent session's
 *   identity. `reason` says why, and is printed with the report.
 */
export type RunEnv =
  | { readonly kind: "ephemeral"; readonly home?: HomeSeed }
  | { readonly kind: "inherit"; readonly reason: string };

/** One file a seed writes, HOME-relative. */
export interface HomeFile {
  readonly path: string;
  readonly contents: string;
}

/** The files a seed writes, sorted by path — or why the seed is refused. */
export type HomePlan =
  | { readonly kind: "ok"; readonly files: readonly HomeFile[] }
  | { readonly kind: "refused"; readonly reason: string };

/** Why `path` cannot be a HOME-relative seed path, or undefined when it can. */
function seedPathProblem(
  path: string,
  keepHomeFiles: readonly string[],
): string | undefined {
  if (path === "") return "an empty path";
  if (path.startsWith("/") || path.includes("\\"))
    return `${JSON.stringify(path)} is not a HOME-relative POSIX path`;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return `${JSON.stringify(path)} must stay inside HOME and be spelled plainly (no "", ".", or ".." segments)`;
  if (keepHomeFiles.includes(path))
    return `${JSON.stringify(path)} is the harness's own auth file, which the run copies in itself; a seed may not replace it`;
  return undefined;
}

/**
 * Validate a seed and list the files it writes. Pure. `keepHomeFiles` are the
 * harness's auth files (`RunEnvPolicy.keepHomeFiles`), copied in after the seed.
 */
export function planHome(
  seed: HomeSeed | undefined,
  keepHomeFiles: readonly string[],
): HomePlan {
  if (seed === undefined) return { kind: "ok", files: [] };
  const paths = Object.keys(seed.files).sort();
  if (paths.length === 0)
    return {
      kind: "refused",
      reason: "a files seed with no files — omit `home` for an empty HOME",
    };
  const problems = paths.flatMap((p) => {
    const why = seedPathProblem(p, keepHomeFiles);
    return why === undefined ? [] : [why];
  });
  if (problems.length > 0)
    return { kind: "refused", reason: problems.join("; ") };
  return {
    kind: "ok",
    files: paths.map((path) => ({ path, contents: seed.files[path] ?? "" })),
  };
}
