/**
 * How a regression case scores a tree (vigiles#416): which of an agent's
 * edits are carried into scoring, and how the scoring processes' results
 * become a trial's metrics. Pure: the git and the processes are behind
 * the {@link RegressionCaseHost} port (`src/host/regression-case.io.ts`), and
 * the flow that calls them is `src/eval-regression-case.ts`.
 *
 * The P0 this module guards is a case scored solved when it was not. Every
 * rule here fails toward "not scored" or "dropped", never toward a score:
 *
 * - a touched set that could not be fully staged is never scored;
 * - an edit under test territory forces `solved: false`;
 * - only regular files and deletions inside `source` are carried; a symlink,
 *   a gitlink or any other entry, an edit on a path the arm wrote, and an
 *   edit outside `source` are dropped and counted;
 * - a timeout is `solved: false`.
 */
import { inSource, matchesAny, type Source } from "./regression-case.js";
import type { TouchedRow, TouchedSet } from "./workspace.js";

/** How one scoring process ended. A command that could not start exits 127. */
export type ScoringRun =
  | { readonly kind: "exited"; readonly code: number }
  /** Killed by a signal (a crash, the OOM killer), not by the timeout. */
  | { readonly kind: "signalled"; readonly signal: string }
  /** Never started: not found, not executable. Counts as a fail, like any run but `exited 0`. */
  | { readonly kind: "not-started"; readonly detail: string }
  | { readonly kind: "timed-out"; readonly ms: number };

/** Why a trial is left out of the scores instead of being scored. */
export type IntegrityWhy = "unstaged" | "outside-link" | "shadow-unhealthy";

/** A trial's metrics: the documented report keys of a regression case. */
export interface CaseMetrics {
  readonly solved: boolean;
  readonly editedTests: boolean;
  readonly droppedEdits: number;
  readonly ignoredNewFiles: number;
  readonly scoringTimedOut: boolean;
}

/** The score of one trial: metrics, or left out for integrity. */
export type CaseScore =
  | { readonly kind: "scored"; readonly metrics: CaseMetrics }
  | { readonly kind: "integrity"; readonly why: IntegrityWhy };

/** What the scoring of one tree found, before it becomes metrics. */
export type TreeOutcome =
  | { readonly kind: "integrity"; readonly why: IntegrityWhy }
  | {
      readonly kind: "edited-tests";
      readonly droppedEdits: number;
      readonly ignoredNewFiles: number;
    }
  | {
      readonly kind: "ran";
      /** Undefined for `build: none`. */
      readonly build: ScoringRun | undefined;
      /** One per oracle path, in order, up to the first that did not pass. */
      readonly tests: readonly ScoringRun[];
      readonly droppedEdits: number;
      readonly ignoredNewFiles: number;
    };

/** The rules an agent's touched set is judged by. */
export interface CarryRules {
  /** `tests.run` ∪ `tests.data`. */
  readonly territory: readonly string[];
  /** The resolved `source`: declared globs, or the default literal roots. */
  readonly source: Source;
  /** Paths (or directories) the arm wrote: their edits are the arm's. */
  readonly armPaths: readonly string[];
}

/** The verdict on a touched set: never scored, tests edited, or what to carry. */
export type CarryVerdict =
  | { readonly kind: "integrity"; readonly why: "unstaged" }
  | {
      readonly kind: "edited-tests";
      readonly droppedEdits: number;
    }
  | {
      readonly kind: "carry";
      readonly kept: readonly TouchedRow[];
      readonly droppedEdits: number;
    };

/** Judge an agent's touched set (scoreTree steps 1-3 of the #416 design). */
export function carryVerdict(set: TouchedSet, rules: CarryRules): CarryVerdict {
  if (set.unstaged) return { kind: "integrity", why: "unstaged" };
  const kept = set.rows.filter((row) => carried(row, rules));
  const droppedEdits = set.rows.length - kept.length;
  return set.rows.some((row) => matchesAny(row.path, rules.territory))
    ? { kind: "edited-tests", droppedEdits }
    : { kind: "carry", kept, droppedEdits };
}

function carried(row: TouchedRow, rules: CarryRules): boolean {
  return (
    carriesContent(row) &&
    !onArmPath(row.path, rules.armPaths) &&
    inSource(row.path, rules.source)
  );
}

/** A regular file or a deletion; every other entry has state outside the tree. */
function carriesContent(row: TouchedRow): boolean {
  switch (row.entry.kind) {
    case "file":
    case "absent":
      return true;
    case "symlink":
    case "gitlink":
    case "other":
      return false;
  }
}

function onArmPath(path: string, armPaths: readonly string[]): boolean {
  return armPaths.some((a) => path === a || path.startsWith(`${a}/`));
}

export const passed = (run: ScoringRun | undefined): boolean =>
  run === undefined || (run.kind === "exited" && run.code === 0);

const timedOut = (run: ScoringRun | undefined): boolean =>
  run?.kind === "timed-out";

/** Every scoring process of a tree that ran exited 0, and every oracle path ran. */
export function treeSolved(
  outcome: Extract<TreeOutcome, { kind: "ran" }>,
  oracleCount: number,
): boolean {
  return (
    passed(outcome.build) &&
    outcome.tests.length === oracleCount &&
    outcome.tests.every(passed)
  );
}

/** A tree's outcome as a trial's score. */
export function caseScore(
  outcome: TreeOutcome,
  oracleCount: number,
): CaseScore {
  switch (outcome.kind) {
    case "integrity":
      return outcome;
    case "edited-tests":
      return scored(outcome, { solved: false, edited: true, late: false });
    case "ran":
      return scored(outcome, {
        solved: treeSolved(outcome, oracleCount),
        edited: false,
        late: [outcome.build, ...outcome.tests].some(timedOut),
      });
  }
}

function scored(
  counts: { readonly droppedEdits: number; readonly ignoredNewFiles: number },
  facts: {
    readonly solved: boolean;
    readonly edited: boolean;
    readonly late: boolean;
  },
): CaseScore {
  return {
    kind: "scored",
    metrics: {
      solved: facts.solved && !facts.late && !facts.edited,
      editedTests: facts.edited,
      droppedEdits: counts.droppedEdits,
      ignoredNewFiles: counts.ignoredNewFiles,
      scoringTimedOut: facts.late,
    },
  };
}

/**
 * The machine operations a regression case needs beyond `WorkspaceHost` (the
 * port; `src/host/regression-case.io.ts` implements it). Every git call runs
 * without the user's global and system git config.
 */
export interface RegressionCaseHost {
  /**
   * Write the kept rows into `dest`: a file's blob from `gitDir`, a deletion
   * removed, nothing removed recursively. Returns how many rows it refused
   * (a directory on their way in is a link or a file, or a file would replace
   * a directory that still holds entries); the caller counts them as dropped
   * edits.
   */
  carryRows(gitDir: string, rows: readonly TouchedRow[], dest: string): number;
  /** Links under `root` (not followed) that would reach out of it, as `path -> target`. */
  linksOutsideTree(root: string): readonly string[];
  /**
   * Run `argv` in `cwd` in its own process group, with a fresh HOME and a
   * scrubbed env (plus `CI=1`), killed with its group at `timeoutMs` and
   * after it exits.
   */
  runScoring(
    argv: readonly string[],
    at: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<ScoringRun>;
}
