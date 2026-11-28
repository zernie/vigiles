/**
 * One container ATTEMPT of `execution: { kind: "container" }` (vigiles#599):
 * its mounts, how a command the eval writes calls back into vigiles inside the
 * image, the runner that is one `ContainerHost.run`, and what the attempt adds
 * to the cache key, the lock and the report. Deciding a run can be a container
 * run, and the checks before trial 1, are in `./eval-container.ts`.
 *
 * Pure, or takes its effects as arguments: the port is the only effect, and
 * `./eval.ts` hands it in.
 */
import {
  CONTAINER_VIGILES_CLI,
  type ContainerAttempt,
  type Mount,
} from "./core/container.js";
import type { AgentRunArgs, AgentRunner, RunOut } from "./core/eval-driver.js";
import type { EvalReport } from "./core/eval-report.js";
import type { HookFire } from "./core/harness-driver.js";
import {
  CONTAINER,
  oneLine,
  type ExecutionPlan,
  type TrialExecution,
} from "./eval-container.js";
import type { StubLauncher } from "./tool-stub.js";

/** The host directories one attempt reads or writes, each mounted at its own path. */
export interface AttemptDirs {
  readonly cwd: string;
  readonly home: string;
  /** The workspace's base record; the agent never writes it. */
  readonly baseDir?: string;
  /** The stub root: shims, rules, and the call log the shims write. */
  readonly stubRoot?: string;
  /** Where the run writes its model requests (the context check). */
  readonly captureDirs: readonly string[];
  /** A native `--plugin-dir` install; read only. */
  readonly pluginDir?: string;
  /** A materialized plugin's root, which its hook commands name; read only. */
  readonly pluginRoot?: string;
}

const rw = (path: string | undefined): readonly Mount[] =>
  path === undefined ? [] : [{ path, mode: "rw" }];
const ro = (path: string | undefined): readonly Mount[] =>
  path === undefined ? [] : [{ path, mode: "ro" }];

/** The mounts of one attempt. Pure. */
export function attemptMounts(dirs: AttemptDirs): readonly Mount[] {
  return [
    ...rw(dirs.cwd),
    ...rw(dirs.home),
    ...ro(dirs.baseDir),
    ...rw(dirs.stubRoot),
    ...dirs.captureDirs.flatMap(rw),
    ...ro(dirs.pluginDir),
    ...ro(dirs.pluginRoot),
  ];
}

/**
 * How a command the eval writes for the agent calls back into vigiles: on the
 * host, this node and this package's `cli.js` (as before); in a container, the
 * image's `node` and the vigiles the image carries.
 */
export function launcherFor(
  ex: TrialExecution,
  host: StubLauncher,
): StubLauncher {
  return ex.kind === "host"
    ? host
    : { node: "node", cli: CONTAINER_VIGILES_CLI };
}

/** The auto-wired PreToolUse intercept hook's command, for a launcher. */
export function interceptCommand(launcher: StubLauncher): string {
  return `"${launcher.node}" "${launcher.cli}" hook-runtime intercept-tool`;
}

/**
 * Why a container attempt cannot be scored because a hook could not run:
 * exit 126 (not executable) or 127 (not found) means the hook's command is not
 * in the image, so the attempt measured a harness without that hook.
 */
export function hookCouldNotRun(
  hooks: readonly HookFire[],
): string | undefined {
  const broken = hooks.find((h) => h.exitCode === 126 || h.exitCode === 127);
  if (broken === undefined) return undefined;
  const said = oneLine(broken.output).slice(0, 200);
  const tail = said === "" ? "" : `: ${said}`;
  return (
    `hook could not run (exit ${String(broken.exitCode)}): its command is missing in the container image — ` +
    `${broken.name || broken.event}${tail}. The attempt is not scored. ` +
    `Use an image that has the command (execution.image), or execution: { kind: "host" }.`
  );
}

/** What a container runner needs from `./eval.ts`: the argv, the env, the hooks of a run. */
export interface ContainerRunnerParts {
  readonly argv: (a: AgentRunArgs) => readonly string[];
  /** The complete env of the attempt (effort pinned, session identity gone). */
  readonly env: (a: AgentRunArgs) => Readonly<Record<string, string>>;
  readonly hooks: (out: Readonly<RunOut>) => readonly HookFire[];
}

/**
 * The runner of one container attempt: one `ContainerHost.run` per call, which
 * resolves after the container is stopped. An attempt whose container could
 * not be confirmed stopped, or whose hook could not run, THROWS — it is never
 * scored, cached or locked, the same choice as the start guard.
 */
export function containerRunner(
  ex: Extract<TrialExecution, { readonly kind: "container" }>,
  mounts: readonly Mount[],
  parts: ContainerRunnerParts,
): AgentRunner {
  return (a) =>
    ex.plan.port
      .run({
        run: { ...a, env: { ...parts.env(a) }, replaceEnv: true },
        argv: parts.argv(a),
        mounts,
        recipe: ex.recipe,
        options: ex.plan.options,
      })
      .then((attempt) => scoredOut(attempt, parts));
}

function scoredOut(
  attempt: Readonly<ContainerAttempt>,
  parts: ContainerRunnerParts,
): Readonly<RunOut> {
  switch (attempt.kind) {
    case "stop-failed":
      throw new Error(
        `container attempt could not be confirmed stopped (${oneLine(attempt.detail)}): a process ` +
          "it started may still be writing, so the attempt is not scored, cached or locked.",
      );
    case "ran": {
      const broken = hookCouldNotRun(parts.hooks(attempt.out));
      if (broken !== undefined) throw new Error(broken);
      return attempt.out;
    }
  }
}

/**
 * What a container run adds to its LOCK inputs; undefined for a host run (its
 * bytes unchanged). Only what the author declared: the kind, the options, and
 * the image they named or the binary vigiles builds one for. Like a host lock,
 * it leaves out the harness version (so `--check` needs no harness binary) and
 * which vigiles the built image carries (so upgrading vigiles, or any change to
 * it, does not make every container lock stale).
 */
export function executionLockView(plan: ExecutionPlan): unknown {
  if (plan.kind === "host") return undefined;
  const image =
    plan.options.image === undefined
      ? { built: plan.binary }
      : { named: plan.options.image };
  return { kind: plan.kind, options: plan.options, image };
}

/**
 * What a container attempt adds to its CACHE key; undefined for a host run.
 * The cache is local, so it pins more than the lock: the host binary's version
 * (the recipe) and the vigiles the image carries (the engine), and a cached
 * attempt never replays under another build.
 */
export function executionCacheView(ex: TrialExecution): unknown {
  if (ex.kind === "host") return undefined;
  const image =
    ex.plan.options.image === undefined
      ? { built: { recipe: ex.recipe, engine: ex.plan.engine } }
      : { named: ex.plan.options.image };
  return { kind: ex.kind, options: ex.plan.options, image };
}

/** The report's `containment`: which image ran the attempts, or why none did. */
export function containmentOf(
  ex: TrialExecution,
): NonNullable<EvalReport["containment"]> {
  if (ex.kind === "host") return { kind: "none", why: "host-runner" };
  const image =
    ex.plan.options.image ??
    [ex.recipe.base, ...ex.recipe.npmPackages].join(" + ");
  return { kind: "container", image };
}

/** Printed once per host run: what a container would end. */
export const HOST_CONTAINMENT_LINE =
  "processes the agent started may outlive a trial and write while it is scored; " +
  `${CONTAINER} ends them.`;
