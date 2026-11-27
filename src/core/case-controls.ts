/**
 * The verdict over a regression case's three controls (vigiles#416), run
 * through the same `scoreTree` every trial goes through:
 *
 * - red: the world as the agent gets it. The oracle must fail, or the case
 *   scores `solved` for free.
 * - gold: the world plus the fix's own reverted part. The oracle must pass,
 *   or no agent can solve it and every trial reads as a miss.
 * - gold + test edit: gold plus an edit under test territory. It must be
 *   caught as a test edit, or the rule that guards every score is broken.
 *
 * Red and gold run `runs` times and must agree with themselves. Pure: the
 * outcomes come from `src/eval-case-qualify.ts`.
 */
import type { ControlRefusal } from "./regression-case-refusal.js";
import {
  treeSolved,
  type ScoringRun,
  type TreeOutcome,
} from "./case-scoring.js";

/** Each control's outcomes, one per run. */
export interface ControlOutcomes {
  readonly red: readonly TreeOutcome[];
  readonly gold: readonly TreeOutcome[];
  readonly goldEdit: readonly TreeOutcome[];
}

/** What the controls decide: the case qualifies, is refused, or vigiles failed. */
export type ControlVerdict =
  | {
      readonly kind: "qualified";
      /** Solved per run; for the provenance. */
      readonly red: readonly boolean[];
      readonly gold: readonly boolean[];
      readonly goldEdit: readonly boolean[];
    }
  | { readonly kind: "refused"; readonly refusal: ControlRefusal }
  /** A tree vigiles built could not be scored as built: a fault, never the user's. */
  | { readonly kind: "fault"; readonly detail: string };

type Ran = Extract<TreeOutcome, { kind: "ran" }>;
type Control = "red" | "gold";

/** Decide a case's controls. `oracle` is the list of oracle paths, in order. */
export function controlVerdict(
  o: ControlOutcomes,
  oracle: readonly string[],
): ControlVerdict {
  const red = ranAll(o.red, "red");
  const gold = ranAll(o.gold, "gold");
  if (red.kind === "fault") return red;
  if (gold.kind === "fault") return gold;
  if (!o.goldEdit.every((t) => t.kind === "edited-tests"))
    return {
      kind: "fault",
      detail: "the gold + test edit control was not caught as a test edit",
    };
  const refusal =
    timeoutOf(red.runs, gold.runs) ?? decide(red.runs, gold.runs, oracle);
  return refusal === undefined
    ? {
        kind: "qualified",
        red: red.runs.map((t) => treeSolved(t, oracle.length)),
        gold: gold.runs.map((t) => treeSolved(t, oracle.length)),
        goldEdit: o.goldEdit.map(() => false),
      }
    : { kind: "refused", refusal };
}

function ranAll(
  outcomes: readonly TreeOutcome[],
  control: Control,
):
  | { readonly kind: "ran"; readonly runs: readonly Ran[] }
  | { readonly kind: "fault"; readonly detail: string } {
  const notRan = outcomes.find((t) => t.kind !== "ran");
  if (notRan === undefined)
    return { kind: "ran", runs: outcomes.filter((t) => t.kind === "ran") };
  const why = notRan.kind === "integrity" ? notRan.why : "a test edit";
  return {
    kind: "fault",
    detail: `the ${control} control was left out: ${why}`,
  };
}

/** The first control that hit the scoring timeout, naming the build when it was the build. */
function timeoutOf(
  red: readonly Ran[],
  gold: readonly Ran[],
): ControlRefusal | undefined {
  const named: readonly (readonly [Control, Ran])[] = [
    ...red.map((t) => ["red", t] as const),
    ...gold.map((t) => ["gold", t] as const),
  ];
  return named.map(([control, t]) => lateIn(control, t)).find(Boolean);
}

/** The timeout of one control run: the build's first, then a test's. */
function lateIn(control: Control, t: Ran): ControlRefusal | undefined {
  if (t.build?.kind === "timed-out")
    return { kind: "scoring-timed-out", control: "build", ms: t.build.ms };
  const late = t.tests.find((r) => r.kind === "timed-out");
  return late?.kind === "timed-out"
    ? { kind: "scoring-timed-out", control, ms: late.ms }
    : undefined;
}

/** Red must fail every run, gold must pass every run; the first broken rule refuses. */
function decide(
  red: readonly Ran[],
  gold: readonly Ran[],
  oracle: readonly string[],
): ControlRefusal | undefined {
  const brokenBuild = red.find((t) => !buildPassed(t));
  return brokenBuild === undefined
    ? solvedRule(
        red.map((t) => treeSolved(t, oracle.length)),
        gold.map((t) => treeSolved(t, oracle.length)),
        oracle,
      )
    : {
        kind: "outdated",
        why: "build-fails-after-revert",
        exitCode: exitCodeOf(brokenBuild.build),
      };
}

/** The rules over solved-per-run, once every red build passed. */
function solvedRule(
  red: readonly boolean[],
  gold: readonly boolean[],
  oracle: readonly string[],
): ControlRefusal | undefined {
  if (red.every(Boolean))
    return {
      kind: "outdated",
      why: "oracle-passes-without-fix",
      paths: oracle,
    };
  if (mixed(red) || mixed(gold)) return { kind: "oracle-flaky", red, gold };
  return gold.some(Boolean)
    ? undefined
    : { kind: "fix-not-reproducible-under-scoring", gold };
}

const buildPassed = (t: Ran): boolean =>
  t.build === undefined || (t.build.kind === "exited" && t.build.code === 0);

const mixed = (xs: readonly boolean[]): boolean =>
  xs.some(Boolean) && !xs.every(Boolean);

/** A build that did not exit 0, as the exit code a shell would show. */
function exitCodeOf(run: ScoringRun | undefined): number {
  if (run?.kind === "exited") return run.code;
  return run?.kind === "not-started" ? 127 : 128;
}
