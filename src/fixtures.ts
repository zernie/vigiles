// 🔴 PUBLIC ENTRY POINT `vigiles/fixtures` — every export here is a promise to users. The default
// for a symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b)
// it is a deliberate extension point listed in STABILITY.md. Review point: the diff of
// `api-surface/vigiles-fixtures.api.md`, which `npm run api:check` fails on.
/**
 * `vigiles/fixtures` — the world a test runs against: tool stubs on PATH and
 * disposable services.
 *
 * Its reader is someone setting up what a harness run TALKS TO, not someone
 * asserting on the run. That is a separate job from the root's verbs and
 * checks, so it has its own door (v50). Nothing here calls a model.
 *
 *   import { experimental_stub } from "vigiles/fixtures";
 *   const gh = experimental_stub("gh", [{ argv: ["auth", "status"], reply: { kind: "always", stdout: "ok\n" } }]);
 */

// Tool stubs on PATH (rung R2): a fake binary that answers PER INVOCATION, by
// rules over its argv. The rule shapes (`ToolStub`, `StubRule`, …) stay on the
// root, because `EvalSpec.stubs` speaks them; writing the shims is internal
// (`tool-stub.ts`).
export { experimental_stub } from "./stub.js";
export type { StubCalledBounds } from "./stub.js";

// --- R3: the disposable-service tier (⚠️ EXPERIMENTAL, and it has REAL EFFECTS) ---
// It is free of MODEL cost, which is why it is not on `vigiles/eval` (every
// runtime export there is `paid_*`: this call can bill you). Free of model cost
// is not free of consequence: the disposable container is the ONLY isolation
// vigiles provides — it does NOT confine the skill's filesystem or network. Run
// it somewhere disposable with no production access and keep real credentials
// out of the run. See the SAFETY note in src/services.ts.
export {
  experimental_startServices,
  type ServiceSpec,
  type ServiceReady,
  type ServiceReset,
  type ServiceHandle,
  type ServiceSession,
  type ContainerRuntime,
} from "./services.js";

export {
  experimental_dockerRuntime,
  type DockerExec,
} from "./services-docker.js";
