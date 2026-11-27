/**
 * The two exactly-one choices of an `EvalSpec`, as ONE Zod schema that is both
 * the runtime check and (through `test/types/eval-spec-schema.ts`) the type.
 *
 * `paid_runEval` is the one runner, so a spec is two questions wide — how many
 * configurations, and how is a trial scored — and each answer is exactly one of
 * two:
 *
 * - `arms`, or none (one arm, {@link DEFAULT_ARM}, configured at top level);
 * - `checks`, `measure(ctx)`, or `experimental_regressionCases` (each case is
 *   its own task, scored by its own oracle tests).
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
import {
  EvalSpecRefusalError,
  parseRegressionCases,
  type RegressionCaseEntry,
} from "./core/regression-case-entries.js";
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

/** How an eval spec scores its trials, after the boundary. */
export type ShapeScoring =
  | {
      readonly kind: "trial";
      /** The task prompt every trial is given. */
      readonly task: string;
      /** Scores one trial: the caller's `measure`, or each check's pass as 0/1. */
      readonly measure: (ctx: RunContext) => Readonly<Metrics>;
      /** Each check-scored metric key → its check; absent for `measure(ctx)`. */
      readonly checks?: Readonly<Record<string, CheckJSON>>;
    }
  | {
      readonly kind: "cases";
      /** Each case is its own task, scored by its own oracle tests. */
      readonly cases: readonly RegressionCaseEntry[];
      readonly checks?: never;
    };

/** An eval spec's configurations and scoring, after the boundary. */
export type EvalShape = {
  readonly arms: Readonly<Record<string, EvalArm>>;
} & ShapeScoring;

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

const TASK = z.string({ error: "is the prompt given to the agent: a string." });

const CHECKS = z.object({
  task: TASK,
  checks: z
    .array(check, { error: CHECK_LIST })
    .min(1, { error: CHECK_LIST })
    .readonly(),
  measure: unset,
  experimental_regressionCases: unset,
});

/** The spec's own `measure` type: written out here, the two could differ. */
type MeasureFn = NonNullable<EvalSpec["measure"]>;

const MEASURE = z.object({
  task: TASK,
  measure: z.custom<MeasureFn>(isFunction, {
    error: "is a function of the run: `measure: (ctx) => ({ … })`.",
  }),
  checks: unset,
  experimental_regressionCases: unset,
});

/** A field a regression-case eval does not take: set, it is refused with why. */
const besideCases = (why: string): Readonly<z.ZodOptional<z.ZodUndefined>> =>
  z.undefined({ error: why }).optional();

/**
 * The entries are checked in full by `parseRegressionCases`, which names each
 * malformed field; here the branch only needs to know the key is a list.
 */
const CASES = z.object({
  experimental_regressionCases: z.custom<readonly RegressionCaseEntry[]>(
    (v) => Array.isArray(v),
    { error: "is a list of regression cases." },
  ),
  task: besideCases(
    "is not set beside regression cases: each case's symptom file is its task.",
  ),
  checks: besideCases(
    "is not set beside regression cases: each case is scored by its oracle tests.",
  ),
  measure: besideCases(
    "is not set beside regression cases: each case is scored by its oracle tests.",
  ),
  experimental_workspace: besideCases(
    "is not set beside regression cases: each case builds its own world.",
  ),
  fixture: besideCases(
    "is not set beside regression cases: a case's world is its repository.",
  ),
  cache: z
    .literal("off", {
      error:
        'must be "off" beside regression cases: a cached trial replays a tree the agent never edited.',
    })
    .optional(),
});

const SCORING_REWRITE =
  '  checks: [check.tool("Bash"), …]   — the check vocabulary, each a 0/1 metric\n' +
  "  measure: (ctx) => ({ … })          — your own metrics from each run\n" +
  "  experimental_regressionCases: […]  — fix commits of your repo, each scored by its tests";

/** The scoring keys, in the order of the union's branches. */
const SCORING_KEYS = [
  "checks",
  "measure",
  "experimental_regressionCases",
] as const;

/**
 * The fields of an eval spec that pick its arms and its scoring. Every other
 * field is checked by name in `runEvalWith` and passes through.
 */
export const EVAL_SHAPE = z
  .object({ stubSkillBodies: z.boolean().optional() })
  .and(z.union([ARMS, ONE_ARM], { error: (iss) => branchError(iss, "arms") }))
  .and(z.union([CHECKS, MEASURE, CASES], { error: scoringError }))
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
  const set = SCORING_KEYS.filter((k) => inputField(iss, k) !== undefined);
  const only = set.at(0);
  if (set.length !== 1 || only === undefined) {
    const has =
      set.length === 0 ? "none" : set.map((k) => quoted([k])).join(" and ");
    return `score each trial with exactly ONE of \`checks\`, \`measure\` or \`experimental_regressionCases\` — this spec has ${has}:\n${SCORING_REWRITE}`;
  }
  return (iss.errors[SCORING_KEYS.indexOf(only)] ?? [])
    .map(describe)
    .join("\n");
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

/**
 * A regression-case spec's cases, or undefined for any other spec. Everything
 * the case branch refuses, and every malformed entry, throws an
 * {@link EvalSpecRefusalError}: the runner calls this before `skipIf`, so a
 * spec that skips here does not hide its misconfiguration.
 */
export function regressionCasesOf(
  spec: unknown,
): readonly RegressionCaseEntry[] | undefined {
  const raw: unknown =
    typeof spec === "object" && spec !== null
      ? Reflect.get(spec, "experimental_regressionCases")
      : undefined;
  if (raw === undefined) return undefined;
  const parsed = EVAL_SHAPE.safeParse(spec);
  if (!parsed.success)
    throw new EvalSpecRefusalError(
      parsed.error.issues.map(describe).join("\n"),
    );
  return parseRegressionCases(raw);
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
function scoringOf(spec: EvalShapeInput): ShapeScoring {
  if (spec.experimental_regressionCases !== undefined)
    return {
      kind: "cases",
      cases: parseRegressionCases(spec.experimental_regressionCases) ?? [],
    };
  if (spec.measure !== undefined)
    return { kind: "trial", task: spec.task, measure: spec.measure };
  const keyed = checkMetricKeys(spec.checks ?? []);
  return {
    kind: "trial",
    task: spec.task,
    measure: (ctx) =>
      Object.fromEntries(keyed.map(([k, c]) => [k, c.eval(ctx).pass])),
    checks: Object.fromEntries(keyed.map(([k, c]) => [k, c.toJSON()])),
  };
}
