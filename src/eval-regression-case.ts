/**
 * The scoring flow of a regression case (vigiles#416): `scoreTree`, the one
 * pipeline every scored tree goes through. The rules it applies are pure
 * (`src/core/case-scoring.ts`); the machine is behind the `WorkspaceHost` and `RegressionCaseHost` ports,
 * wired by a root.
 *
 * `scoreTree`, in order (the #416 design's steps):
 *
 * 1. The touched set against the trial's own base. A set that could not be
 *    fully staged, or a broken base record, is left out of the scores.
 * 2. An edit under test territory forces `solved: false`; nothing runs.
 * 3. Only regular files and deletions inside `source`, off the arm's paths,
 *    are carried; the rest are dropped and counted.
 * 4. A FRESH clone of the case's scoring template, never the trial dir; the
 *    kept edits and the installs go in, then the outside-link scan reruns on
 *    that final tree before anything runs. A hit is left out of the scores.
 * 5. The build, then each oracle path, as separate scoring processes.
 *
 * Trial calls are serialised: two suites never run at once (fixed ports,
 * shared temp paths), whatever the trial concurrency.
 */
import {
  caseScore,
  carryVerdict,
  passed,
  type CarryVerdict,
  type CaseScore,
  type RegressionCaseHost,
  type ScoringRun,
  type TreeOutcome,
} from "./core/case-scoring.js";
import { refuseCommandOutsideRunner } from "./core/eval-load-phase.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { runEffect } from "./effect-run.js";
import {
  ShadowUnhealthyError,
  type RepoTemplate,
  type TouchedSet,
  type TrialBase,
  type TrialWorkspaceView,
  type WorkspaceHost,
} from "./core/workspace.js";

/** Both ports a case needs; a root wires one value for both. */
export type CaseHost = WorkspaceHost & RegressionCaseHost;

/** Everything about a qualified case that scoring reads. */
export interface ScoringWorld {
  /** The case's scoring template: the world tree, one `baseline` commit. */
  readonly template: RepoTemplate;
  /** The user's work tree top, where the installs are copied from. */
  readonly top: string;
  readonly installs: readonly string[];
  readonly oracle: readonly string[];
  /** `tests.run` ∪ `tests.data`. */
  readonly territory: readonly string[];
  /** The resolved `source`. */
  readonly source: readonly string[];
  readonly build:
    | { readonly kind: "command"; readonly argv: readonly string[] }
    | { readonly kind: "none"; readonly reason: string };
  readonly testCommand: readonly string[];
  readonly timeoutMs: number;
}

/** One tree to score: a trial dir and its base record. */
export interface ScoredTree {
  readonly cwd: string;
  readonly base: TrialBase;
  readonly armPaths: readonly string[];
}

/** The host and the world a scoring call reads. */
export interface Scoring {
  readonly host: CaseHost;
  readonly world: ScoringWorld;
}

interface Counts {
  readonly droppedEdits: number;
  readonly ignoredNewFiles: number;
}

const WHAT = "the regression case's build and test commands";

/** Score one tree (unserialised: trials go through {@link caseScorer}). */
export async function scoreTree(
  host: CaseHost,
  world: ScoringWorld,
  tree: ScoredTree,
): Promise<TreeOutcome> {
  refuseCommandOutsideRunner(WHAT);
  const touched = touchedOrBroken(host, tree);
  if (touched === undefined)
    return { kind: "integrity", why: "shadow-unhealthy" };
  const verdict = carryVerdict(touched, {
    territory: world.territory,
    source: world.source,
    armPaths: tree.armPaths,
  });
  return scoreVerdict({ host, world }, { tree, touched, verdict });
}

async function scoreVerdict(
  s: Scoring,
  at: {
    readonly tree: ScoredTree;
    readonly touched: TouchedSet;
    readonly verdict: CarryVerdict;
  },
): Promise<TreeOutcome> {
  const { verdict } = at;
  const ignoredNewFiles = at.touched.ignoredNewFiles;
  switch (verdict.kind) {
    case "integrity":
      return verdict;
    case "edited-tests":
      return { ...verdict, ignoredNewFiles };
    case "carry":
      return carryAndRun(s, { tree: at.tree, ignoredNewFiles }, verdict);
  }
}

/** Carry the kept rows into a scoring clone and run the oracle there; refused rows count as dropped. */
function carryAndRun(
  s: Scoring,
  at: { readonly tree: ScoredTree; readonly ignoredNewFiles: number },
  verdict: Extract<CarryVerdict, { kind: "carry" }>,
): Promise<TreeOutcome> {
  return inScoringClone(s, async (dir) => {
    const refused = s.host.carryRows(at.tree.base.gitDir, verdict.kept, dir);
    return runIn(s, dir, {
      droppedEdits: verdict.droppedEdits + refused,
      ignoredNewFiles: at.ignoredNewFiles,
    });
  });
}

/** The touched set, or undefined when the base record itself is broken; any other fault throws. */
function touchedOrBroken(
  host: CaseHost,
  tree: ScoredTree,
): TouchedSet | undefined {
  try {
    return host.touchedPaths(tree.base, tree.cwd);
  } catch (e) {
    if (e instanceof ShadowUnhealthyError) return undefined;
    throw e;
  }
}

/**
 * A fresh clone of the case's template, removed after `fn` — also when the
 * clone or `fn` throws and when the run is interrupted (acquire/use/release).
 */
function inScoringClone(
  s: Scoring,
  fn: (dir: string) => Promise<TreeOutcome>,
): Promise<TreeOutcome> {
  return runEffect(({ Effect }) =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeTmpDir("case-scoring")),
      (dir) =>
        Effect.tryPromise({
          try: () => {
            s.host.cloneTemplate(s.world.template, dir);
            return fn(dir);
          },
          catch: (e) => e,
        }),
      (dir) =>
        Effect.sync(() => {
          s.host.removeDir(dir);
        }),
    ),
  );
}

/** Installs in, the link rescan, then the build and each oracle path. */
async function runIn(
  s: Scoring,
  dir: string,
  counts: Counts,
): Promise<TreeOutcome> {
  const { host, world } = s;
  host.copyInstalls(world.top, world.installs, dir);
  if (host.linksOutsideTree(dir).length > 0)
    return { kind: "integrity", why: "outside-link" };
  const at = { cwd: dir, timeoutMs: world.timeoutMs };
  const build =
    world.build.kind === "command"
      ? await host.runScoring(world.build.argv, at)
      : undefined;
  const tests = passed(build) ? await oracleRuns(s, at, world.oracle) : [];
  return { kind: "ran", build, tests, ...counts };
}

/** Each oracle path in order, stopping at the first that does not pass. */
async function oracleRuns(
  s: Scoring,
  at: { readonly cwd: string; readonly timeoutMs: number },
  paths: readonly string[],
): Promise<readonly ScoringRun[]> {
  if (paths.length === 0) return [];
  const [path = "", ...rest] = paths;
  const run = await s.host.runScoring([...s.world.testCommand, path], at);
  return passed(run) ? [run, ...(await oracleRuns(s, at, rest))] : [run];
}

/** A trial as the runner hands it to the scorer. */
export interface ScoredTrial {
  readonly cwd: string;
  readonly experimental_workspace?: TrialWorkspaceView;
}

/**
 * The scorer of a case's trials, serialised by one lock. Rejects (a vigiles
 * wiring fault, never an agent outcome) on a trial without its workspace view.
 */
export function caseScorer(
  host: CaseHost,
  world: ScoringWorld,
): (trial: ScoredTrial) => Promise<CaseScore> {
  const lock = oneAtATime();
  return (trial) => {
    const view = trial.experimental_workspace;
    if (view === undefined)
      return Promise.reject(
        new Error("a regression case trial has no experimental_workspace view"),
      );
    const tree = { cwd: trial.cwd, base: view, armPaths: view.armPaths };
    return lock(async () =>
      caseScore(await scoreTree(host, world, tree), world.oracle.length),
    );
  };
}

/**
 * Run each `fn` holding the one permit of a semaphore, so two suites never
 * run at once. `effect` loads lazily (see `src/effect-run.ts`), so the
 * semaphore is made on the first import, once per scorer.
 */
function oneAtATime(): <T>(fn: () => Promise<T>) => Promise<T> {
  const permit = import("effect").then(({ Semaphore }) =>
    Semaphore.makeUnsafe(1),
  );
  return async (fn) => {
    const sem = await permit;
    return runEffect(({ Effect }) =>
      sem.withPermits(1)(Effect.tryPromise({ try: fn, catch: (e) => e })),
    );
  };
}
