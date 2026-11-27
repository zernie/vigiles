/**
 * The lock key of `experimental_regressionCases` (vigiles#416), computed
 * WITHOUT qualifying a case, so `--check` reads git and never runs a build
 * or a test suite. It holds, per case, the entry as written and the
 * lockfiles its installs are keyed by at `head`; the fingerprint of the
 * eval engine (`dist/eval-engine.json`, written by the build); and the Node
 * major the scoring ran on.
 *
 * What it does not see, stated so nobody relies on it: a dependency bump
 * with no vigiles change (bare packages are not hashed), `dist/cli.js` (the
 * engine reaches it by path, not by import), and the user's tests and source
 * outside the fix (the commits are pinned by SHA, the tree is not hashed).
 */
import type { EngineFingerprint, EvalHost } from "./core/eval-host.js";
import type { RegressionCaseEntry } from "./core/regression-case-entries.js";
import { RegressionCaseRefusalError } from "./core/regression-case-refusal.js";
import type { LockMode } from "./eval-lock.js";
import { planWorld } from "./eval-case-plan.js";
import { checkedTop } from "./eval-workspace.js";

/** What the cases add to a lock: its inputs, and why no lock may be written. */
export interface CasesLock {
  readonly inputs: unknown;
  readonly why: string | undefined;
}

/**
 * The cases' part of the lock. Under `off` nothing is read. A missing
 * engine fingerprint throws under `check` (a lock that cannot tell whether
 * the engine changed is neither replayed nor run) and, under `update`, runs
 * the eval but writes no lock.
 */
export function casesLock(
  host: EvalHost,
  entries: readonly RegressionCaseEntry[],
  mode: LockMode,
): CasesLock {
  if (mode === "off") return { inputs: undefined, why: undefined };
  const engine = host.engineFingerprint();
  // First, so `check` throws before any git read.
  const why = engineRefusal(engine, mode);
  return {
    inputs: {
      cases: entries.map((entry) => ({
        case: entry,
        lockfiles: lockfilesOf(host, entry),
      })),
      engine: engine.kind === "found" ? engine.hash : undefined,
      node: host.nodeMajor(),
    },
    why,
  };
}

function engineRefusal(
  engine: EngineFingerprint,
  mode: Exclude<LockMode, "off">,
): string | undefined {
  if (engine.kind === "found") return undefined;
  const why = `the eval engine's fingerprint ${engine.path} is missing, so a lock could not go stale when the code that scores the cases changes — rebuild vigiles (\`npm run build\`)`;
  if (mode === "check") throw new Error(`vigiles eval --check: ${why}`);
  return `${why}; no lock is written.`;
}

function lockfilesOf(
  host: EvalHost,
  entry: RegressionCaseEntry,
): readonly { readonly path: string; readonly blob: string }[] {
  const plan = planWorld(host, checkedTop(host, entry.repo), entry);
  if (plan.kind === "refused")
    throw new RegressionCaseRefusalError(entry.id, plan.refusal);
  return plan.deps.lockfiles.map(({ path, blob }) => ({ path, blob }));
}
