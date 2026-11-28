/**
 * `env: { kind: "docker" }` for `runEval` (vigiles#599): deciding a
 * run can be a container run, and the machine checks before its first trial.
 * Each ATTEMPT then runs in a fresh container that is stopped before the
 * attempt is scored, so a process the agent started cannot write into the
 * trial's folder while it is scored (#626); what one attempt needs is in
 * `./eval-container-attempt.ts`.
 *
 * Why per attempt and not per trial: a retried attempt re-lays the trial
 * folder with rm + mkdir (a new inode), and a container started before that
 * would keep writing into the deleted folder. So one attempt is one
 * `ContainerHost.run`, called after the attempt's world is laid; it resolves
 * only after the container is stopped.
 *
 * Everything here is pure or takes its effects as arguments; the spawn, the
 * temp dirs and the `--version` read stay in `./eval.ts`, and Docker stays in
 * the machine adapter behind the `ContainerHost` port (`./core/container.ts`).
 */
import { omit } from "remeda";

import type {
  ContainerHost,
  ContainerOptions,
  ContainerPreflight,
  HarnessImageRecipe,
  Mount,
} from "./core/container.js";
import type { EngineFingerprint, EvalHost } from "./core/eval-host.js";
import type { DockerRunEnv, NormalizedRunEnv } from "./core/run-env.js";
import type {
  ContainerImageDeclaration,
  HarnessRuntime,
} from "./core/runtime.js";

/**
 * A container run that cannot start, refused before its first trial with one
 * line naming the cure. `vigiles eval` prints it as a refusal, not a stack.
 */
export class ContainerRefusalError extends Error {
  override readonly name = "ContainerRefusalError";
}

/** How the refusals name the setting, as the spec spells it. */
export const CONTAINER = 'env: { kind: "docker" }';

/** The run that stays on this machine, as the refusals name it. */
const ON_HOST = 'env: { kind: "local", inherit: "none" }';

/** Where a run's agent process runs, once its harness and machine are known. */
export type ExecutionPlan =
  | { readonly kind: "host" }
  | {
      readonly kind: "container";
      readonly options: ContainerOptions;
      readonly image: ContainerImageDeclaration;
      /** The harness binary (`agentBinary`), named in the refusals. */
      readonly binary: string;
      readonly port: ContainerHost;
      /** Which vigiles the image carries: the engine the build fingerprinted. */
      readonly engine: EngineFingerprint;
    };

/** The container half of {@link ExecutionPlan}. */
export type ContainerPlan = Extract<
  ExecutionPlan,
  { readonly kind: "container" }
>;

/** How each trial of a run executes, once the machine answered ready. */
export type TrialExecution =
  | { readonly kind: "host" }
  | {
      readonly kind: "container";
      readonly plan: ContainerPlan;
      readonly recipe: HarnessImageRecipe;
    };

const noImage = (harness: string): string =>
  `${CONTAINER} is not supported for the ${harness} harness yet: its adapter declares no ` +
  `container image. Use ${ON_HOST}.`;

const NO_ADAPTER =
  `${CONTAINER} needs the container adapter, and this run was not given one. Run the eval ` +
  "with `vigiles eval <file>` or `paid_runEval` from vigiles/eval.";

/**
 * Decide, at the spec boundary, where this run's agent process runs: on the
 * host for `local`; for `docker`, the harness must declare
 * its image and the root must have wired the container adapter. Throws a
 * {@link ContainerRefusalError} naming which is missing.
 */
export function planExecution(
  env: NormalizedRunEnv,
  runtime: Pick<HarnessRuntime, "name" | "agentBinary" | "containerImage">,
  host: EvalHost | undefined,
): ExecutionPlan {
  switch (env.kind) {
    case "local":
      return { kind: "host" };
    case "docker":
      return containerPlan(containerOptionsOf(env), runtime, host);
  }
}

/** A docker env's {@link ContainerOptions}: everything but `kind` and `home`. */
function containerOptionsOf(env: DockerRunEnv): ContainerOptions {
  return omit(env, ["kind", "home"]);
}

function containerPlan(
  options: ContainerOptions,
  runtime: Pick<HarnessRuntime, "name" | "agentBinary" | "containerImage">,
  host: EvalHost | undefined,
): ContainerPlan {
  const image = runtime.containerImage;
  if (image === undefined)
    throw new ContainerRefusalError(noImage(runtime.name));
  const port = host?.container;
  if (host === undefined || port === undefined)
    throw new ContainerRefusalError(NO_ADAPTER);
  return {
    kind: "container",
    options,
    image,
    binary: runtime.agentBinary,
    port,
    engine: host.engineFingerprint(),
  };
}

const RERUN = "then re-run.";

/** One line per preflight answer that stops the run, naming the cure; undefined when ready. */
export function preflightRefusal(p: ContainerPreflight): string | undefined {
  switch (p.kind) {
    case "ready":
      return undefined;
    case "no-docker":
      return `${CONTAINER} needs Docker, and no Docker daemon answered. Start Docker Desktop (macOS) or the docker service (Linux), ${RERUN} (${oneLine(p.detail)})`;
    case "no-testcontainers":
      return `${CONTAINER} needs the testcontainers package, which is not installed. Run \`npm i -D testcontainers\`, ${RERUN}`;
    case "testcontainers-failed":
      return `${CONTAINER} could not load the testcontainers package (${oneLine(p.detail)}). Reinstall it with \`npm i -D testcontainers\`, ${RERUN}`;
    case "node-too-old":
      return `${CONTAINER} needs Node ${p.need} or newer (testcontainers requires it), and this is Node ${p.have}. Upgrade Node, or use ${ON_HOST}, ${RERUN}`;
    case "ryuk-disabled":
      return `${CONTAINER} needs Ryuk, the testcontainers reaper that removes a container vigiles could not, and TESTCONTAINERS_RYUK_DISABLED turns it off. Unset it, ${RERUN}`;
    case "mount-failed":
      return `${CONTAINER} could not mount ${p.path} into a container (${oneLine(p.detail)}). Share that directory with Docker (Docker Desktop: Settings → Resources → File sharing), ${RERUN}`;
    case "no-egress":
      return `${CONTAINER}: a container could not reach ${p.url} (${oneLine(p.detail)}). Behind a proxy that decrypts HTTPS, point NODE_EXTRA_CA_CERTS at its CA file (the image vigiles builds trusts it; a named image must already); networkMode: "none" blocks the model API too, ${RERUN}`;
    case "image-failed":
      return `${CONTAINER} could not build or pull its image (${oneLine(p.detail)}). Check the image name and the network, ${RERUN}`;
  }
}

/** `s` on one line: its lines trimmed and joined by a space. */
export const oneLine = (s: string): string =>
  s
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");

/**
 * On macOS a container run needs one of the harness's token variables: the
 * login a host run uses sits in the Keychain, which a Linux container cannot
 * read. Undefined when the run can authenticate.
 */
export function macAuthRefusal(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  image: ContainerImageDeclaration,
): string | undefined {
  if (platform !== "darwin") return undefined;
  if (image.authEnv.some((name) => (env[name] ?? "") !== "")) return undefined;
  return (
    `${CONTAINER} on macOS needs ${image.authEnv.join(" or ")} in the environment: a login kept in ` +
    `the macOS Keychain cannot be read inside a Linux container. Run \`${image.authCure}\`, export ` +
    `the token it prints, ${RERUN}`
  );
}

/** The machine facts {@link readyExecution} reads, passed in so it stays testable. */
export interface ReadyMachine {
  /**
   * Reads the raw `--version` output of the binary the runner drives ("unknown"
   * when that binary is absent). Undefined when the runner drives no binary
   * vigiles knows: one passed in without a registered version.
   */
  readonly rawVersion: (() => string) | undefined;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directories of the same kind trial 1 mounts, and how to remove them. */
  readonly probeMounts: () => {
    readonly mounts: readonly Mount[];
    readonly dispose: () => void;
  };
}

/**
 * Everything checked before trial 1 of a container run, in the order a user
 * fixes them: the host binary's version (the image pins it), macOS auth, then
 * the machine (Docker, testcontainers, the mounts, the image). Throws a
 * {@link ContainerRefusalError} with the cure; a host run passes untouched.
 */
export async function readyExecution(
  plan: ExecutionPlan,
  machine: ReadyMachine,
): Promise<TrialExecution> {
  if (plan.kind === "host") return plan;
  const recipe = recipeOrRefuse(plan, machine.rawVersion);
  refuseIf(macAuthRefusal(machine.platform, machine.env, plan.image));
  const probe = machine.probeMounts();
  try {
    const answer = await plan.port.preflight({
      mounts: probe.mounts,
      recipe,
      options: plan.options,
      egressProbe: plan.image.egressProbe(machine.env),
    });
    refuseIf(preflightRefusal(answer));
  } finally {
    probe.dispose();
  }
  return { kind: "container", plan, recipe };
}

function recipeOrRefuse(
  plan: ContainerPlan,
  readVersion: (() => string) | undefined,
): HarnessImageRecipe {
  if (readVersion === undefined)
    throw new ContainerRefusalError(
      `${CONTAINER} builds its image with the version of the ${plan.binary} the run drives, and this ` +
        `run's agent runner names no binary. Run the eval with \`vigiles eval <file>\` or \`paid_runEval\` ` +
        `from vigiles/eval, ${RERUN}`,
    );
  const rawVersion = readVersion();
  const recipe = plan.image.recipe(rawVersion);
  if (recipe !== undefined) return recipe;
  throw new ContainerRefusalError(
    `${CONTAINER} builds its image with the host's ${plan.binary} version, and \`${plan.binary} --version\` ` +
      `printed none (${oneLine(rawVersion)}). Install ${plan.binary}, ${RERUN}`,
  );
}

function refuseIf(line: string | undefined): void {
  if (line !== undefined) throw new ContainerRefusalError(line);
}
