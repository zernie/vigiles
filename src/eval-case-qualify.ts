/**
 * The pre-flight of a regression case (vigiles#416): every check that can
 * refuse a case before its first trial, in the order a user fixes them, and
 * the case's world built from its fix commit. A case that passes is a
 * {@link PreparedCase}; one that cannot measure anything is refused, at no
 * model cost.
 *
 * The order:
 *
 * 1. History: `head` resolves, the fix and its one parent are in the
 *    repository, the fix is an ancestor of `head`.
 * 2. Paths: the fix split into oracle, test territory and reverted paths,
 *    then the path refusals (`src/core/regression-case.ts`).
 * 3. The symptom file, then the installs and their lockfiles.
 * 4. The world: `head` with each reverted file's own hunk reversed, the
 *    symptom file and `hide` removed. A non-Markdown file that does not
 *    reverse is a `revert-conflict`. Built as a sealed template from `head`
 *    plus one patch, so no object of the fix's version of a reverted file is
 *    ever written into it.
 * 5. Links out of the world or its installs.
 * 6. The three controls (`src/core/case-controls.ts`), each tree through
 *    the shipped `scoreTree` and the run's scoring lock.
 *
 * The user's checkout is only read: the reads are behind the
 * `CaseWorldHost` port, the copies are vigiles' own temp dirs.
 */
import { controlVerdict, type ControlOutcomes } from "./core/case-controls.js";
import type { TreeOutcome } from "./core/case-scoring.js";
import {
  goldEditRows,
  type CaseWorldHost,
  type TreeEntry,
} from "./core/case-world.js";
import {
  resolvedSource,
  type FixSplit,
  type RegressionCaseSpec,
} from "./core/regression-case.js";
import type { RegressionCaseRefusal } from "./core/regression-case-refusal.js";
import { makeTmpDir } from "./core/tmp-root.js";
import type { RepoTemplate, TouchedRow } from "./core/workspace.js";
import { planWorld, refused, type Planned } from "./eval-case-plan.js";
import {
  scoreTree,
  type CaseHost,
  type ScoringLock,
  type ScoringWorld,
} from "./eval-regression-case.js";

/** Every port the pre-flight reads; a root wires one value. */
export type QualifyHost = CaseHost & CaseWorldHost;

/** The default wall-clock limit of each scoring process: 10 minutes. */
export const DEFAULT_SCORING_TIMEOUT_MS = 600_000;
const DEFAULT_RUNS = 2;

/** A case that passed its pre-flight: what its trials and its report need. */
export interface PreparedCase {
  readonly world: ScoringWorld;
  readonly head: string;
  readonly split: FixSplit;
  /** The symptom file's text at `head`: the agent's task. */
  readonly task: string;
  readonly markdownKeptAtHead: readonly string[];
  /** The lockfiles that key the installs, as committed at `head`. */
  readonly lockfiles: readonly TreeEntry[];
  /** Solved per control run, for the provenance. */
  readonly controls: {
    readonly red: readonly boolean[];
    readonly gold: readonly boolean[];
    readonly goldEdit: readonly boolean[];
  };
  /** Remove the world's template; the case's trials and scoring end first. */
  dispose(): void;
}

/** What the pre-flight decides. A vigiles fault throws instead. */
export type Qualification =
  | { readonly kind: "qualified"; readonly prepared: PreparedCase }
  | { readonly kind: "refused"; readonly refusal: RegressionCaseRefusal };

/**
 * Qualify one case of the work tree at `top` (resolved by the caller).
 * `lock` is the run's scoring lock, shared with every scorer.
 */
export async function qualifyCase(
  host: QualifyHost,
  at: { readonly top: string; readonly lock: ScoringLock },
  spec: RegressionCaseSpec,
): Promise<Qualification> {
  const plan = planWorld(host, at.top, spec);
  if (plan.kind === "refused") return plan;
  const template = host.buildTemplate({
    dir: at.top,
    ref: plan.head,
    patch: plan.patch,
  });
  const dispose = (): void => {
    host.removeDir(template.root);
  };
  return disposedUnlessQualified(dispose, () =>
    qualifyWorld(host, { ...at, spec, plan, template, dispose }),
  );
}

/** Run `fn`; dispose the template when it refuses or throws. */
async function disposedUnlessQualified(
  dispose: () => void,
  fn: () => Promise<Qualification>,
): Promise<Qualification> {
  try {
    const q = await fn();
    if (q.kind === "refused") dispose();
    return q;
  } catch (e) {
    dispose();
    throw e;
  }
}

interface Built {
  readonly top: string;
  readonly lock: ScoringLock;
  readonly spec: RegressionCaseSpec;
  readonly plan: Planned;
  readonly template: RepoTemplate;
  readonly dispose: () => void;
}

/** Steps 5-6 on the built template. */
async function qualifyWorld(
  host: QualifyHost,
  b: Built,
): Promise<Qualification> {
  const links = host.linksOutside(b.template, b.top, b.plan.deps.installs);
  if (links.length > 0)
    return refused({ kind: "deps-link-outside-world", links });
  const world = scoringWorld(b);
  const outcomes = await runControls(host, b, world);
  const verdict = controlVerdict(outcomes, world.oracle);
  switch (verdict.kind) {
    case "fault":
      throw new Error(`regression case ${b.spec.commit}: ${verdict.detail}`);
    case "refused":
      return refused(verdict.refusal);
    case "qualified":
      return {
        kind: "qualified",
        prepared: prepared(host, { ...b, world }, verdict),
      };
  }
}

function scoringWorld(b: Built): ScoringWorld {
  const { spec, plan } = b;
  return {
    template: b.template,
    top: b.top,
    installs: plan.deps.installs,
    oracle: plan.split.oracle,
    territory: [...spec.tests.run, ...spec.tests.data],
    source: resolvedSource(spec.source, plan.split),
    build: spec.build,
    testCommand: spec.testCommand,
    timeoutMs: spec.scoringTimeoutMs ?? DEFAULT_SCORING_TIMEOUT_MS,
  };
}

function prepared(
  host: QualifyHost,
  b: Built & { readonly world: ScoringWorld },
  controls: PreparedCase["controls"],
): PreparedCase {
  return {
    world: b.world,
    head: b.plan.head,
    split: b.plan.split,
    task: host.showFile(b.top, b.plan.head, b.spec.symptom.path) ?? "",
    markdownKeptAtHead: b.plan.markdownKeptAtHead,
    lockfiles: b.plan.deps.lockfiles,
    controls: {
      red: controls.red,
      gold: controls.gold,
      goldEdit: controls.goldEdit,
    },
    dispose: b.dispose,
  };
}

interface ControlAt {
  readonly world: ScoringWorld;
  readonly lock: ScoringLock;
  /** The user's git dir: gold's blobs are read from it, never written. */
  readonly userGitDir: string;
}

/** Red and gold `runs` times each, gold + test edit once, one after another. */
async function runControls(
  host: QualifyHost,
  b: Built,
  world: ScoringWorld,
): Promise<ControlOutcomes> {
  const runs = b.spec.runs ?? DEFAULT_RUNS;
  const at: ControlAt = { world, lock: b.lock, userGitDir: host.gitDir(b.top) };
  const tree = (rows: readonly TouchedRow[]) => (): Promise<TreeOutcome> =>
    controlTree(host, at, rows);
  return {
    red: await inSeries(runs, tree([])),
    gold: await inSeries(runs, tree(b.plan.gold)),
    goldEdit: await inSeries(1, tree(goldEditRows(b.plan.gold, world.oracle))),
  };
}

async function inSeries<T>(
  n: number,
  fn: () => Promise<T>,
): Promise<readonly T[]> {
  if (n <= 0) return [];
  const first = await fn();
  return [first, ...(await inSeries(n - 1, fn))];
}

/** One control tree in its own temp dirs, removed after it is scored. */
async function controlTree(
  host: QualifyHost,
  at: ControlAt,
  rows: readonly TouchedRow[],
): Promise<TreeOutcome> {
  const cwd = makeTmpDir("case-control");
  const gitDir = makeTmpDir("case-control-base");
  try {
    return await scoreControl(host, at, { cwd, gitDir, rows });
  } finally {
    host.removeDir(cwd);
    host.removeDir(gitDir);
  }
}

/**
 * A trial dir cloned from the world, its base recorded, `rows` written
 * from the user's objects, then scored like any trial, under the lock.
 */
function scoreControl(
  host: QualifyHost,
  at: ControlAt,
  t: {
    readonly cwd: string;
    readonly gitDir: string;
    readonly rows: readonly TouchedRow[];
  },
): Promise<TreeOutcome> {
  const { cwd, gitDir } = t;
  host.cloneTemplate(at.world.template, cwd);
  const base = host.recordTrialBase(at.world.template, {
    gitDir,
    cwd,
    armPaths: [],
  });
  host.carryRows(at.userGitDir, t.rows, cwd);
  const tree = { cwd, base: { gitDir, baseTree: base.baseTree }, armPaths: [] };
  return at.lock(() => scoreTree(host, at.world, tree));
}
