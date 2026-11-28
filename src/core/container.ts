/**
 * Where an eval's agent process runs, and the port that runs it in a container
 * (vigiles#599). On the host runner, a process the agent started in the
 * background can outlive its trial and write into the trial's folder while it
 * is scored (#626); in a container, stopping the container ends every process
 * the attempt started, the same way on Linux and macOS.
 *
 * This file is the CONTRACT between the trial pipeline (app, `src/eval.ts`),
 * which decides what to run and what to mount, and the machine adapter
 * (`src/host/container.io.ts`), which owns Docker. Types only: no fs, no spawn.
 */
import type { AgentRunArgs, RunOut } from "./eval-driver.js";

/**
 * The settings of the container a trial runs in that cannot break its
 * containment. Names follow the `testcontainers` builder methods they map to
 * (`withPlatform`, `withNetworkMode`, …). Settings that would break it — reuse
 * across trials, turning off removal, extra env, extra mounts, another user or
 * command, privileged mode — have no field here, so they cannot be passed.
 *
 * @public
 */
export interface ContainerOptions {
  /** A ready image to run instead of the one vigiles builds. It must contain the harness binary at the host's version and vigiles. */
  readonly image?: string;
  readonly platform?: string;
  readonly pullPolicy?: "default" | "always";
  /** Docker network mode. Default: Docker's own (`bridge`, open egress). `"none"` is fully offline, the model API included. */
  readonly networkMode?: string;
  /** Memory in GB and CPU count, as `withResourcesQuota` takes them. */
  readonly resourcesQuota?: { readonly memory?: number; readonly cpu?: number };
  /** Bytes. */
  readonly sharedMemorySize?: number;
  readonly ulimits?: Readonly<
    Record<string, { readonly hard?: number; readonly soft?: number }>
  >;
  readonly extraHosts?: readonly {
    readonly host: string;
    readonly ipAddress: string;
  }[];
  /** Container path → mount options, as `withTmpFs` takes them. */
  readonly tmpFs?: Readonly<Record<string, string>>;
  readonly droppedCapabilities?: readonly string[];
}

/** Where the agent of an eval runs. The default is the host. */
export type Execution =
  | { readonly kind: "host" }
  | { readonly kind: "container"; readonly options: ContainerOptions };

/** A host directory mounted into the container at the SAME absolute path. */
export interface Mount {
  readonly path: string;
  readonly mode: "rw" | "ro";
}

/**
 * The harness half of the image vigiles builds: the base image and the npm
 * packages that put the harness binary in it, at the host's version. Declared
 * by the harness adapter (Claude Code: `@anthropic-ai/claude-code@<version>`);
 * the container adapter adds vigiles itself.
 *
 * @public
 */
export interface HarnessImageRecipe {
  readonly base: string;
  readonly npmPackages: readonly string[];
  /** The binary the run starts (`claude`). */
  readonly binary: string;
  /**
   * A URL the binary must reach to work (Claude Code: the model API). The
   * preflight requests it from inside a container started like a run's, with
   * the image's `node`; any HTTP status is reachable. Absent: not probed.
   * Not an image input, so it does not change the image tag.
   */
  readonly egressProbe?: string;
}

/** Where vigiles's own CLI sits inside an image vigiles built. */
export const CONTAINER_VIGILES_CLI =
  "/opt/vigiles/lib/node_modules/vigiles/dist/cli.js";

/** One attempt to run in a fresh container. */
export interface ContainerRunArgs {
  /** The same arguments the host runner gets. `run.env` is the COMPLETE env (an ephemeral one). */
  readonly run: AgentRunArgs;
  /** The binary's arguments, as the host runner would spawn them. */
  readonly argv: readonly string[];
  readonly mounts: readonly Mount[];
  readonly recipe: HarnessImageRecipe;
  readonly options: ContainerOptions;
}

/**
 * How one attempt ended. The container is ALWAYS stopped before this value
 * exists; `stop-failed` means it could not be confirmed stopped, so the
 * attempt must not be scored or cached.
 */
export type ContainerAttempt =
  | { readonly kind: "ran"; readonly out: RunOut }
  | {
      readonly kind: "stop-failed";
      readonly out: RunOut;
      readonly detail: string;
    };

/** What stops a container run before trial 1, each with its own cure. */
export type ContainerPreflight =
  | { readonly kind: "ready" }
  | { readonly kind: "no-docker"; readonly detail: string }
  | { readonly kind: "no-testcontainers" }
  | { readonly kind: "ryuk-disabled" }
  | {
      readonly kind: "mount-failed";
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly kind: "no-egress";
      readonly url: string;
      /** The error code the request failed with (`SELF_SIGNED_CERT_IN_CHAIN`, `ENOTFOUND`, …). */
      readonly detail: string;
    }
  | {
      readonly kind: "image-failed";
      readonly detail: string;
    };

/** The machine port: implemented by `src/host/container.io.ts`. */
export interface ContainerHost {
  /** Checked once, before trial 1, with the mounts trial 1 will use. */
  preflight(args: {
    readonly mounts: readonly Mount[];
    readonly recipe: HarnessImageRecipe;
    readonly options: ContainerOptions;
  }): Promise<ContainerPreflight>;
  /** Start a fresh container, run `recipe.binary argv…`, stop it, then resolve. */
  run(args: ContainerRunArgs): Promise<ContainerAttempt>;
}
