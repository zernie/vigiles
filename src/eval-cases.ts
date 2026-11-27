/**
 * `experimental_regressionCases` at run time (vigiles#416): every case is
 * qualified before the first trial, each becomes a {@link TrialPlan} (its own
 * world, task and scorer), and the finished trials become the report's
 * per-case results.
 *
 * Order, so nothing is spent on a run that will be refused: the agent binary,
 * then each case's work tree, then every case's controls, then the disk.
 * Any refusal removes what the earlier cases built and refuses the run.
 */
import type { EvalHost } from "./core/eval-host.js";
import type { CaseScore, IntegrityWhy } from "./core/case-scoring.js";
import type { Metrics } from "./core/eval-aggregate.js";
import type { CaseArmResult, CaseResult } from "./core/eval-report.js";
import type { Source } from "./core/regression-case.js";
import type { RegressionCaseEntry } from "./core/regression-case-entries.js";
import { RegressionCaseRefusalError } from "./core/regression-case-refusal.js";
import { WorkspaceRefusalError } from "./core/workspace.js";
import { qualifyCase, type PreparedCase } from "./eval-case-qualify.js";
import {
  caseScorer,
  scoringLock,
  type ScoringLock,
} from "./eval-regression-case.js";
import type { RunContext } from "./eval.js";
import {
  checkedTop,
  refuseForeignTop,
  type PreparedWorkspace,
} from "./eval-workspace.js";

/** A trial's score: a metric row, or left out of the scores for integrity. */
export type TrialScore =
  | { readonly kind: "row"; readonly row: Metrics }
  | { readonly kind: "unscored"; readonly why: IntegrityWhy };

/** What one trial runs and how it is scored. */
export interface TrialPlan {
  readonly task: string;
  readonly workspace: PreparedWorkspace | undefined;
  /** The case the trial measures; absent for a `checks` or `measure` spec. */
  readonly caseId?: string;
  /** Called while the trial's dir still exists: a case scores its tree. */
  score(ctx: RunContext): Promise<TrialScore>;
}

/** A qualified case and the plan its trials run. */
export interface RunCase {
  readonly entry: RegressionCaseEntry;
  readonly prepared: PreparedCase;
  readonly plan: TrialPlan;
}

/** Whether the agent binary was found. An injected runner is not probed. */
export type AgentProbe =
  | { readonly kind: "found" }
  | { readonly kind: "missing"; readonly binary: string }
  | { readonly kind: "not-probed" };

/** What the cases need from the rest of the run. */
export interface CasesContext {
  readonly host: EvalHost;
  readonly concurrency: number;
  /** The harness the run drives. */
  readonly driven: string;
  readonly agent: AgentProbe;
}

interface At {
  readonly host: EvalHost;
  readonly lock: ScoringLock;
}

/**
 * Qualify every case, in order, with one scoring lock shared by its controls
 * and its trials. Throws a {@link RegressionCaseRefusalError} or a
 * {@link WorkspaceRefusalError}; nothing is left on disk when it throws.
 */
export async function prepareCases(
  entries: readonly RegressionCaseEntry[],
  ctx: CasesContext,
): Promise<readonly RunCase[]> {
  refuseMissingAgent(ctx.agent);
  const pending = entries.map((entry) => ({
    entry,
    top: caseTop(ctx, entry),
  }));
  const cases = await qualifyAll(
    pending,
    { host: ctx.host, lock: scoringLock() },
    [],
  );
  try {
    refuseLowDisk(ctx, cases);
  } catch (e) {
    disposeCases(cases);
    throw e;
  }
  return cases;
}

/** Remove every case's world template. */
export function disposeCases(cases: readonly RunCase[]): void {
  cases.forEach((c) => {
    c.prepared.dispose();
  });
}

function refuseMissingAgent(agent: AgentProbe): void {
  if (agent.kind === "missing")
    throw new RegressionCaseRefusalError(undefined, {
      kind: "agent-binary-missing",
      binary: agent.binary,
    });
}

function caseTop(ctx: CasesContext, entry: RegressionCaseEntry): string {
  const top = checkedTop(ctx.host, entry.repo);
  refuseForeignTop(ctx.host, top, { sha: entry.head, driven: ctx.driven });
  return top;
}

async function qualifyAll(
  pending: readonly {
    readonly entry: RegressionCaseEntry;
    readonly top: string;
  }[],
  at: At,
  done: readonly RunCase[],
): Promise<readonly RunCase[]> {
  const next = pending.at(0);
  if (next === undefined) return done;
  const prepared = await qualifyOne(at, next).catch((e: unknown) => {
    disposeCases(done);
    throw e;
  });
  return qualifyAll(pending.slice(1), at, [
    ...done,
    runCase(at, next.entry, prepared),
  ]);
}

/** Qualify one case; a refusal throws, naming the case. */
async function qualifyOne(
  at: At,
  { entry, top }: { readonly entry: RegressionCaseEntry; readonly top: string },
): Promise<PreparedCase> {
  const q = await qualifyCase(at.host, { top, lock: at.lock }, entry);
  if (q.kind === "refused")
    throw new RegressionCaseRefusalError(entry.id, q.refusal);
  return q.prepared;
}

function runCase(
  at: At,
  entry: RegressionCaseEntry,
  prepared: PreparedCase,
): RunCase {
  const score = caseScorer(at.host, prepared.world, at.lock);
  return {
    entry,
    prepared,
    plan: {
      task: prepared.task,
      workspace: caseWorkspace(at.host, entry, prepared),
      caseId: entry.id,
      score: async (trial) => trialScore(await score(trial)),
    },
  };
}

/** The case's world as the workspace every one of its trials is cloned from. */
function caseWorkspace(
  host: EvalHost,
  entry: RegressionCaseEntry,
  { world }: PreparedCase,
): PreparedWorkspace {
  return {
    host,
    template: world.template,
    top: world.top,
    installs: world.installs,
    world: host.readWorld(world.template),
    lockView: { tree: world.template.tree, deps: entry.deps.kind },
  };
}

/** A case's score as a metric row: the documented `case.*` keys. */
function trialScore(s: CaseScore): TrialScore {
  if (s.kind === "integrity") return { kind: "unscored", why: s.why };
  const m = s.metrics;
  return {
    kind: "row",
    row: {
      "case.solved": m.solved,
      "case.editedTests": m.editedTests,
      "case.droppedEdits": m.droppedEdits,
      "case.ignoredNewFiles": m.ignoredNewFiles,
      "case.scoringTimedOut": m.scoringTimedOut,
    },
  };
}

/**
 * Each trial in flight holds a world and its installs, and the one scoring
 * at a time holds as much again; the templates already exist. Refuse when
 * the temp file system cannot hold `(concurrency + 1) ×` the largest case.
 */
function refuseLowDisk(ctx: CasesContext, cases: readonly RunCase[]): void {
  const { host } = ctx;
  const sizes = cases.map(({ prepared: { world } }) =>
    world.installs.reduce(
      (sum, i) => sum + host.treeBytes(`${world.top}/${i}`),
      host.treeBytes(world.template.root),
    ),
  );
  const neededBytes = (ctx.concurrency + 1) * Math.max(0, ...sizes);
  const freeBytes = host.freeBytes(host.tmpRoot());
  if (freeBytes < neededBytes)
    throw new WorkspaceRefusalError({
      kind: "not-enough-disk",
      neededBytes,
      freeBytes,
    });
}

/** A finished trial, as the per-case results read it. */
export interface ScoredUnit {
  readonly armName: string;
  readonly caseId?: string;
  readonly score: TrialScore;
}

/**
 * The report's per-case results: one per case, in the spec's order, each
 * with every arm. Nothing for a spec without cases.
 */
export function casesReport(
  cases: readonly RunCase[],
  armNames: readonly string[],
  units: readonly ScoredUnit[],
): { readonly experimental_regressionCases?: readonly CaseResult[] } {
  if (cases.length === 0) return {};
  return {
    experimental_regressionCases: cases.map((c) =>
      caseResult(c, armNames, units),
    ),
  };
}

function caseResult(
  { entry, prepared }: RunCase,
  armNames: readonly string[],
  units: readonly ScoredUnit[],
): CaseResult {
  return {
    id: entry.id,
    commit: entry.commit,
    head: prepared.head,
    source: sourceList(prepared.world.source),
    oracle: prepared.world.oracle,
    markdownKeptAtHead: prepared.markdownKeptAtHead,
    controls: prepared.controls,
    build:
      entry.build.kind === "command"
        ? { kind: "command" }
        : { kind: "none", reason: entry.build.reason },
    arms: Object.fromEntries(
      armNames.map((arm) => [arm, armResult(entry.id, arm, units)]),
    ),
  };
}

function armResult(
  caseId: string,
  arm: string,
  all: readonly ScoredUnit[],
): CaseArmResult {
  const units = all.filter((u) => u.caseId === caseId && u.armName === arm);
  const rows = units.flatMap((u) =>
    u.score.kind === "row" ? [u.score.row] : [],
  );
  return {
    solved: rows.filter((r) => r["case.solved"] === true).length,
    scored: rows.length,
    unscored: units.length - rows.length,
  };
}

/** The resolved `source` as paths: the declared globs, or each default root. */
function sourceList(source: Source): readonly string[] {
  return source.kind === "declared"
    ? source.globs
    : source.roots.map((r) => (r.kind === "dir" ? `${r.dir}/` : r.path));
}
