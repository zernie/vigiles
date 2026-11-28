/**
 * Type-level constraint: `RunEnv` cannot express a container around your real
 * HOME, a seed written into it, or a local run that does not say what it
 * inherits. Each illegal combination is a tsc error at the spec, not a refusal
 * at run time. Compiled with `tsc --noEmit` (npm run test:types); nothing runs.
 */
import type { DockerRunEnv, RunEnv } from "../../dist/entries/index.js";

// Guards: the three kinds a spec may write.
export const real: RunEnv = {
  kind: "local",
  inherit: "all",
  reason: "my plugins",
};
export const throwaway: RunEnv = {
  kind: "local",
  inherit: "none",
  home: { kind: "files", files: { ".gitconfig": "" } },
};
export const docker: RunEnv = {
  kind: "docker",
  home: { kind: "files", files: { ".gitconfig": "" } },
  networkMode: "none",
};

// Guards: the deprecated spellings still compile, so an existing spec builds.
export const oldInherit: RunEnv = { kind: "inherit", reason: "my plugins" };
export const oldEphemeral: RunEnv = { kind: "ephemeral" };

// Guards: a container never inherits, so `inherit` on docker does not compile.
export const inheritOnDocker: RunEnv = {
  kind: "docker",
  // @ts-expect-error `inherit` exists only on the local kind
  inherit: "all",
};

// Guards: a seed on your real HOME does not compile.
export const seedOnReal: RunEnv = {
  kind: "local",
  inherit: "all",
  reason: "r",
  // @ts-expect-error `home` exists only on a throwaway HOME
  home: { kind: "files", files: {} },
};

// Guards: a reason on a throwaway HOME does not compile.
export const reasonOnThrowaway: RunEnv = {
  kind: "local",
  inherit: "none",
  // @ts-expect-error `reason` exists only on inherit: "all"
  reason: "r",
};

// Guards: a local run must say what it inherits; there is no default.
// @ts-expect-error `inherit` is required on the local kind
export const localWithoutInherit: RunEnv = { kind: "local" };

// Guards: a container option on your real HOME does not compile.
export const containerOnReal: RunEnv = {
  kind: "local",
  inherit: "all",
  reason: "r",
  // @ts-expect-error `image` exists only on the docker kind
  image: "x",
};

// Guards: a container is not a local run with a reason.
export const reasonOnDocker: DockerRunEnv = {
  kind: "docker",
  // @ts-expect-error `reason` exists only on inherit: "all"
  reason: "r",
};
