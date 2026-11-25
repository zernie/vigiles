/**
 * The two exactly-one choices of an `EvalSpec`, read into one shape before
 * anything is packaged or spent.
 *
 * `paid_runEval` is the one runner: until v55 it had two siblings — one
 * configuration scored by `checks`, and several scored by `checks` — that were
 * the same operation under other names. Folding them in left a spec two
 * questions wide — how many configurations, and how is a trial scored — and
 * each answer is exactly one of two:
 *
 * - `arms`, or none (one arm, {@link DEFAULT_ARM}, configured at top level);
 * - `checks`, or `measure(ctx)`.
 *
 * The TYPE makes "both" and "neither" an error, but most eval files are plain
 * `.mjs` and nothing type-checks them — so this module refuses the same shapes
 * at run time, with the rewrite, before the first trial. A wrong shape here
 * would otherwise be silently read as one of the two (the runner picks the
 * `measure` and ignores the `checks`) and report a confident number about a
 * setup the author did not write.
 */
import type { Check } from "./check.js";
import type { CheckJSON } from "./core/eval-report.js";
import type { Metrics } from "./core/eval-aggregate.js";
import type { EvalArm, EvalSpec, RunContext } from "./eval.js";
import { checkMetricKeys } from "./eval-check-report.js";

/** The name of the one arm of an eval declared without `arms`. */
export const DEFAULT_ARM = "default";

/**
 * The fields that configure the one arm of an eval with no `arms`. Beside
 * `arms` they are refused: which arm would they configure?
 */
export const SINGLE_ARM_KEYS = [
  "settings",
  "plugin",
  "pluginDir",
  "skillsDir",
  "interceptTools",
] as const satisfies readonly (keyof EvalArm)[];

/** An eval spec's configurations and scoring, after the boundary. */
export interface EvalShape {
  readonly arms: Readonly<Record<string, EvalArm>>;
  /** Scores one trial: the caller's `measure`, or each check's pass as 0/1. */
  readonly measure: (ctx: RunContext) => Readonly<Metrics>;
  /** Each check-scored metric key → its check; absent for `measure(ctx)`. */
  readonly checks?: Readonly<Record<string, CheckJSON>>;
}

/** The scoring half of an {@link EvalShape}. */
type Scoring = Readonly<Pick<EvalShape, "measure" | "checks">>;

function refuse(message: string): never {
  throw new Error(`runEval: ${message}`);
}

/** The value of a spec field read by name — the spec arrives untyped from `.mjs`. */
function field(spec: object, key: string): unknown {
  const v: unknown = Reflect.get(spec, key);
  return v;
}

/**
 * Read an eval spec's configurations and scoring, refusing every shape the
 * type forbids. Pure: no file is read, nothing runs.
 */
export function shapeEvalSpec<M extends Metrics>(spec: EvalSpec<M>): EvalShape {
  const arms = armsOf(spec);
  const scoring = scoringOf(spec);
  refuseStubWithoutInstall(spec, arms);
  return { arms, ...scoring };
}

/** A record of arms by name — not an array, not a scalar. */
function isArmRecord(v: unknown): v is Readonly<Record<string, EvalArm>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const quoted = (k: string): string => "`" + k + "`";

/** `arms` as given, or the one {@link DEFAULT_ARM} built from the top-level fields. */
function armsOf(spec: object): Readonly<Record<string, EvalArm>> {
  const top = SINGLE_ARM_KEYS.filter((k) => field(spec, k) !== undefined);
  const arms = field(spec, "arms");
  if (arms === undefined)
    return {
      [DEFAULT_ARM]: Object.fromEntries(top.map((k) => [k, field(spec, k)])),
    };
  if (top.length > 0) {
    const them = top.length === 1 ? "it" : "them";
    refuse(
      `${top.map(quoted).join(", ")} configure the one arm of an eval with no \`arms\`. ` +
        `This spec has \`arms\`: set ${them} on each arm instead.`,
    );
  }
  if (!isArmRecord(arms))
    refuse("`arms` maps each arm's name to its configuration.");
  return arms;
}

const SCORING_REWRITE =
  '  checks: [check.tool("Bash"), …]   — the check vocabulary, each a 0/1 metric\n' +
  "  measure: (ctx) => ({ … })          — your own metrics from each run";

/** The scoring: exactly one of `checks` and `measure`. */
function scoringOf(spec: object): Scoring {
  const checks = field(spec, "checks");
  const measure = field(spec, "measure");
  if ((checks === undefined) === (measure === undefined)) {
    const has = checks === undefined ? "neither" : "both";
    refuse(
      `score each trial with exactly ONE of \`checks\` or \`measure\` — this spec has ${has}:\n${SCORING_REWRITE}`,
    );
  }
  if (measure !== undefined) return { measure: measureOf(measure) };
  return checkScoring(checks, field(spec, "stubSkillBodies") === true);
}

/** A metric function: the type cannot be checked further at run time. */
function isMeasure(v: unknown): v is (ctx: RunContext) => Readonly<Metrics> {
  return typeof v === "function";
}

function measureOf(v: unknown): (ctx: RunContext) => Readonly<Metrics> {
  if (!isMeasure(v))
    refuse("`measure` is a function of the run: `measure: (ctx) => ({ … })`.");
  return v;
}

/** A non-empty list whose every entry has the methods scoring calls. */
function isCheckList(v: unknown): v is readonly Check<RunContext>[] {
  return Array.isArray(v) && v.length > 0 && v.every(isCheck);
}

/** `checks` as the measure that scores them, plus the key → check record. */
function checkScoring(v: unknown, stubbed: boolean): Scoring {
  if (!isCheckList(v)) return refuse(checkListProblem(v));
  const keyed = checkMetricKeys(v);
  // A stubbed skill body leaves no output to grade: a `judged` check would
  // score an empty body and read as a quality finding.
  if (stubbed && keyed.some(([, c]) => c.toJSON().kind === "judged"))
    refuse(
      "`stubSkillBodies` is for firing / `check.skill()` checks only — it stubs the skill body, " +
        "so there is no output for a `judged` check to grade. Drop `stubSkillBodies`, or the `judged` check.",
    );
  return {
    measure: (ctx) =>
      Object.fromEntries(keyed.map(([k, c]) => [k, c.eval(ctx).pass])),
    checks: Object.fromEntries(keyed.map(([k, c]) => [k, c.toJSON()])),
  };
}

/** Why a `checks` value is not a list of checks. */
function checkListProblem(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0)
    return "`checks` is a non-empty list of checks — a run scored by no check measures nothing.";
  const bad = String(v.findIndex((c) => !isCheck(c)));
  return `\`checks[${bad}]\` is not a check — build each with the \`check.*\` vocabulary.`;
}

/** A value with the two methods a run's scoring calls on a check. */
function isCheck(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof field(v, "eval") === "function" &&
    typeof field(v, "toJSON") === "function"
  );
}

/** `stubSkillBodies` with no arm that installs a skill would stub nothing. */
function refuseStubWithoutInstall(
  spec: object,
  arms: Readonly<Record<string, EvalArm>>,
): void {
  if (field(spec, "stubSkillBodies") !== true) return;
  const installs = Object.values(arms).some(
    (a) => a.pluginDir !== undefined || a.skillsDir !== undefined,
  );
  if (!installs)
    refuse(
      "`stubSkillBodies` requires `pluginDir` or `skillsDir` — on the spec, or on at least one arm.",
    );
}
