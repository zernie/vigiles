/**
 * The two exactly-one choices of an `EvalSpec`, as ONE Zod schema that is both
 * the runtime check and (through `test/types/eval-spec-schema.ts`) the type.
 *
 * `paid_runEval` is the one runner, so a spec is two questions wide — how many
 * configurations, and how is a trial scored — and each answer is exactly one of
 * two:
 *
 * - `arms`, or none (one arm, {@link DEFAULT_ARM}, configured at top level);
 * - `checks`, or `measure(ctx)`.
 *
 * The TYPE makes "both" and "neither" an error, but most eval files are plain
 * `.mjs` and nothing type-checks them — so the same shapes are refused at run
 * time, with the rewrite, before the first trial. A wrong shape would otherwise
 * be read as one of the two (the runner picks `measure`, ignores `checks`) and
 * report a confident number about a setup the author did not write.
 *
 * 🔴 WHY A SCHEMA AND NOT GUARDS. The first draft restated `EvalSpec` as
 * hand-written guards (`isArmRecord`, `isCheckList`, …); two copies of one rule
 * drift, and the drift shows as a `.mjs` caller refused for a spec TypeScript
 * accepts, or the reverse. Here the unions ARE the rule: `EvalSpec` stays
 * hand-written (it is generic in `M`, and Zod infers no generics), and a
 * type-level equality test binds its scoring and arm fields to
 * `z.input<typeof EVAL_SHAPE>`, so neither side can change alone.
 *
 * Function-valued fields (`measure`, a check's `eval`/`toJSON`) are
 * `z.custom` over `typeof … === "function"`, not `z.function()`: Zod 4's
 * function schema returns a WRAPPED function, and a check's methods and the
 * caller's `measure` must reach the runner as written.
 */
import { z } from "zod";
import type { Check } from "./check.js";
import type { CheckJSON } from "./core/eval-report.js";
import type { Metrics } from "./core/eval-aggregate.js";
import type { ToolIntercept } from "./tool-intercept.js";
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

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

const isFunction = (v: unknown): boolean => typeof v === "function";

/** The two methods a run's scoring calls on a check. */
const CHECK_METHODS = z.looseObject({
  eval: z.custom(isFunction),
  toJSON: z.custom(isFunction),
});

const check = z.custom<Check<RunContext>>(
  (v) => CHECK_METHODS.safeParse(v).success,
  { error: "is not a check — build each with the `check.*` vocabulary." },
);

const CHECK_LIST =
  "is a non-empty list of checks — a run scored by no check measures nothing.";

const BESIDE_ARMS = "configures the one arm of an eval with no `arms`.";

/** A one-arm field on the `arms` branch: set, it is refused. */
const besideArms = z.undefined({ error: BESIDE_ARMS }).optional();

/** The other branch's field: absent here, which the union decides. */
const unset = z.undefined().optional();

const ARMS = z.object({
  arms: z.record(z.string(), z.custom<EvalArm>(), {
    error: "maps each arm's name to its configuration.",
  }),
  settings: besideArms,
  plugin: besideArms,
  pluginDir: besideArms,
  skillsDir: besideArms,
  interceptTools: besideArms,
});

const ONE_ARM = z.object({
  arms: unset,
  settings: z.unknown().optional(),
  plugin: z.string().optional(),
  pluginDir: z.string().optional(),
  skillsDir: z.string().optional(),
  interceptTools: z.array(z.custom<ToolIntercept>()).readonly().optional(),
});

const CHECKS = z.object({
  checks: z
    .array(check, { error: CHECK_LIST })
    .min(1, { error: CHECK_LIST })
    .readonly(),
  measure: unset,
});

/** The spec's own `measure` type: written out here, the two could differ. */
type MeasureFn = NonNullable<EvalSpec["measure"]>;

const MEASURE = z.object({
  measure: z.custom<MeasureFn>(isFunction, {
    error: "is a function of the run: `measure: (ctx) => ({ … })`.",
  }),
  checks: unset,
});

const SCORING_REWRITE =
  '  checks: [check.tool("Bash"), …]   — the check vocabulary, each a 0/1 metric\n' +
  "  measure: (ctx) => ({ … })          — your own metrics from each run";

/**
 * The fields of an eval spec that pick its arms and its scoring. Every other
 * field is checked by name in `runEvalWith` and passes through.
 */
export const EVAL_SHAPE = z
  .object({ stubSkillBodies: z.boolean().optional() })
  .and(z.union([ARMS, ONE_ARM], { error: (iss) => branchError(iss, "arms") }))
  .and(z.union([CHECKS, MEASURE], { error: scoringError }))
  .superRefine((spec, ctx) => {
    if (spec.stubSkillBodies !== true) return;
    const problem = stubProblem(spec);
    if (problem !== undefined)
      ctx.addIssue({ code: "custom", message: problem });
  });

type EvalShapeInput = Readonly<z.output<typeof EVAL_SHAPE>>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One issue as a sentence about the field it names. */
function describe(issue: z.core.$ZodIssue): string {
  if (issue.path.length === 0) return issue.message;
  return `${quoted(issue.path)} ${issue.message}`;
}

/** `checks[1]`, `pluginDir` — the path the way the author spells it. */
function quoted(path: readonly PropertyKey[]): string {
  const spelled = path
    .map((p) => (typeof p === "number" ? `[${String(p)}]` : String(p)))
    .join("");
  return "`" + spelled + "`";
}

/** What a union refused: Zod raises no other issue from a union itself. */
type UnionIssue = z.core.$ZodRawIssue<z.core.$ZodIssueInvalidUnion>;

/** The input object a union refused, read by field. */
function inputField(iss: UnionIssue, key: string): unknown {
  const input: unknown = iss.input;
  return typeof input === "object" && input !== null
    ? Reflect.get(input, key)
    : undefined;
}

/**
 * A two-branch union told apart by whether `key` is set: report the issues of
 * the branch the author chose (the first when `key` is set), not "invalid input".
 */
function branchError(iss: UnionIssue, key: string): string {
  const chosen = iss.errors[inputField(iss, key) === undefined ? 1 : 0];
  const beside = chosen.filter((i) => i.message === BESIDE_ARMS);
  if (beside.length > 0) return besideArmsMessage(beside);
  return chosen.map(describe).join("\n");
}

/** Every one-arm field set beside `arms`, in one sentence. */
function besideArmsMessage(issues: readonly z.core.$ZodIssue[]): string {
  const them = issues.length === 1 ? "it" : "them";
  return (
    `${issues.map((i) => quoted(i.path)).join(", ")} configure the one arm of an eval with no \`arms\`. ` +
    `This spec has \`arms\`: set ${them} on each arm instead.`
  );
}

/** Both or neither scoring is named with the rewrite; one malformed, by its field. */
function scoringError(iss: UnionIssue): string {
  const hasChecks = inputField(iss, "checks") !== undefined;
  if (hasChecks === (inputField(iss, "measure") !== undefined)) {
    const has = hasChecks ? "both" : "neither";
    return `score each trial with exactly ONE of \`checks\` or \`measure\` — this spec has ${has}:\n${SCORING_REWRITE}`;
  }
  return branchError(iss, "checks");
}

/** Why `stubSkillBodies: true` cannot do its job on this spec, if it cannot. */
function stubProblem(spec: EvalShapeInput): string | undefined {
  // A stubbed skill body leaves no output to grade: a `judged` check would
  // score an empty body and read as a quality finding.
  if ((spec.checks ?? []).some((c) => c.toJSON().kind === "judged"))
    return (
      "`stubSkillBodies` is for firing / `check.skill()` checks only — it stubs the skill body, " +
      "so there is no output for a `judged` check to grade. Drop `stubSkillBodies`, or the `judged` check."
    );
  if (!Object.values(armsOf(spec)).some(installs))
    return "`stubSkillBodies` requires `pluginDir` or `skillsDir` — on the spec, or on at least one arm.";
  return undefined;
}

const installs = (a: EvalArm): boolean =>
  a.pluginDir !== undefined || a.skillsDir !== undefined;

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

/**
 * Read an eval spec's configurations and scoring, refusing every shape the
 * type forbids. Pure: no file is read, nothing runs.
 */
export function shapeEvalSpec(spec: unknown): EvalShape {
  const parsed = EVAL_SHAPE.safeParse(spec);
  if (!parsed.success)
    throw new Error(`runEval: ${parsed.error.issues.map(describe).join("\n")}`);
  return { arms: armsOf(parsed.data), ...scoringOf(parsed.data) };
}

/** `arms` as given, or the one {@link DEFAULT_ARM} built from the top-level fields. */
function armsOf(spec: EvalShapeInput): Readonly<Record<string, EvalArm>> {
  if (spec.arms !== undefined) return spec.arms;
  const { settings, plugin, pluginDir, skillsDir, interceptTools } = spec;
  const arm: EvalArm = {
    settings,
    plugin,
    pluginDir,
    skillsDir,
    interceptTools,
  };
  return {
    [DEFAULT_ARM]: Object.fromEntries(
      Object.entries(arm).filter(([, v]) => v !== undefined),
    ),
  };
}

/** The scoring: the caller's `measure`, or the checks as 0/1 metrics by label. */
function scoringOf(
  spec: EvalShapeInput,
): Pick<EvalShape, "measure" | "checks"> {
  if (spec.measure !== undefined) return { measure: spec.measure };
  const keyed = checkMetricKeys(spec.checks);
  return {
    measure: (ctx) =>
      Object.fromEntries(keyed.map(([k, c]) => [k, c.eval(ctx).pass])),
    checks: Object.fromEntries(keyed.map(([k, c]) => [k, c.toJSON()])),
  };
}
