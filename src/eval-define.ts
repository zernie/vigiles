/**
 * `defineEval` — an eval file DESCRIBES its eval; `vigiles eval` runs it.
 *
 * ## The defect this shape removes
 *
 * Eval files used to do their work in the module body:
 *
 *   const report = await measureTriggerRate({ … });    // ← top level
 *   console.log(formatTriggerRateReport(report));
 *   assertTriggerRate(report, { min: 0.6 });
 *
 * In ESM, `import` IS execution. So the cheapest imaginable question — "does
 * this file even parse?" — answered with `import()` launched a real, paid run
 * against a real model. That happened, and was paid for, on 2026-08-12.
 *
 * The fix is not a better warning. It is that the file no longer HOLDS a runner:
 *
 *   export default defineEval({
 *     measureTriggerRate: { … },                       // ← data
 *     assert: (r) => assertTriggerRate(r, { min: 0.6 }),
 *   });
 *
 * `defineEval` builds a plain value. There is nothing in it to run, so importing
 * it starts nothing — not "is discouraged from starting"; there is no call. The
 * five paid runners are reached only by `eval-entry.ts`, the module `vigiles
 * eval` spawns. After the migration, ZERO of this repo's 19 eval files import a
 * runner at all: the paid subpath is no longer part of an eval file's vocabulary.
 * (18 were already named `*.eval.*`; `from-promptfoo.mjs` was renamed in, because
 * it ran a paid runner at the top level while sitting outside the runner's glob —
 * the same defect in a file nothing would have caught.)
 *
 * ## Why data and not a callback
 *
 * `defineEval({ run: async ({ measure }) => … })` would also make importing
 * inert, and it was rejected on a measurable difference: with a callback the
 * runner cannot know WHAT a file declares without executing it, so "this file
 * declares no eval" becomes undecidable, and the loud report on an unmigrated
 * file — the whole discovery path — becomes impossible. With data it is a
 * property of the value, decided before a cent is spent. (See
 * `eval-define.test.ts`, which asserts exactly that on a fixture.)
 *
 * ## Running the file directly is a LOUD failure, not a no-op
 *
 * Every old eval file was documented as `node path/to/x.eval.mjs`, and that
 * habit outlives the migration. A pure description run that way would print
 * nothing and exit 0 — a silent no-op, the same class of defect in a new place.
 * So `defineEval` refuses when node was pointed straight at an eval file (a
 * POSITIVE identification from `process.argv[1]`, the same fact and the same
 * reasoning `foreign-runner.ts` uses; it cannot be forged by configuration).
 * `node --check <file>` — the free syntax check people should be reaching for —
 * never executes, so it is untouched.
 */
import { basename } from "node:path";
import { isEvalScript } from "./source-kinds.js";

import type {
  ArmsCheckReport,
  EvalDriver,
  ArmsMeasureSpec,
  CheckReport,
  EvalReport,
  EvalSpec,
  MeasureSpec,
  Metrics,
  TriggerRateReport,
  TriggerRateSpec,
} from "./eval.js";
import type {
  SelectionMatrixOptions,
  SelectionReport,
} from "./scan-behavioral.js";

/**
 * Brand marking a value as built by {@link defineEval}. A registered symbol, so
 * a descriptor still reads as one across two copies of the package on disk —
 * the shape a monorepo produces routinely.
 */
export const EVAL_DEFINITION = Symbol.for("vigiles.eval.definition");

/** `measureSelectionMatrix`'s two arguments as one declarable object. */
export interface SelectionMatrixSpec extends SelectionMatrixOptions {
  /** The plugin root whose skills are measured against each other. */
  readonly pluginDir: string;
}

/**
 * The five measurements an eval file may declare — the runners that already
 * exist, keyed by their own names, so migrating is renaming a call to a key.
 * EXACTLY ONE must be present: zero is a file that declares nothing, and two is
 * a file whose author expected both to run.
 */
export interface EvalMeasurements {
  /** A/B across arms with derived metrics — `paid_runEval`. */
  readonly runEval?: EvalSpec<Metrics>;
  /** Checks scored over N trials of one task — `paid_measure`. */
  readonly measure?: MeasureSpec;
  /** The same checks per arm — `paid_measureArms`. */
  readonly measureArms?: ArmsMeasureSpec;
  /** Does a skill's description actually fire — `paid_measureTriggerRate`. */
  readonly measureTriggerRate?: TriggerRateSpec;
  /**
   * The N×N skill-selection collision matrix — `measureSelectionMatrix` from
   * `vigiles/claude-code`. Declared here because a description is a description
   * whatever harness answers it; only `eval-entry.ts` resolves it to a runner.
   */
  readonly measureSelectionMatrix?: SelectionMatrixSpec;
}

/** The report type produced by each declared measurement. */
export interface EvalReports {
  readonly runEval: EvalReport;
  readonly measure: CheckReport;
  readonly measureArms: ArmsCheckReport;
  readonly measureTriggerRate: TriggerRateReport;
  readonly measureSelectionMatrix: SelectionReport;
}

/** The measurement names, as a type. */
export type EvalKind = keyof EvalMeasurements;

/** Everything an eval file declares beyond the measurement itself. */
export interface EvalHooks<K extends EvalKind> {
  /**
   * A lazy precondition. Return a reason to SKIP (exit 77, loud — never a silent
   * green); return nothing to run. Lazy is the point: a probe at the top of the
   * file would be work at import time, which is the shape being removed.
   */
  readonly skipIf?: () => string | false | undefined | null;
  /**
   * What the report has to show. Throw to fail. The runner has already printed
   * the standard report by the time this is called, so this is for the derived
   * reads — gates, per-arm significance, a verdict line.
   */
  readonly assert?: (report: EvalReports[K]) => void | Promise<void>;
  /**
   * Drive the measurement with this harness instead of the real `claude` CLI —
   * the declarative home for the second argument of
   * `measureTriggerRate(spec, { evalDriver })`, e.g. `codexEvalDriver` from
   * `vigiles/codex`, or a fake runner in a test.
   *
   * ⚠️ `measureTriggerRate` ONLY. That is not a limitation of this shape but of
   * the product as it stands: `measureTriggerRate` is the one measurement with a
   * public driver seam, and `runEval(spec)` always drives Claude Code (see
   * docs/harnesses.md, footnote 2). Declaring it with any other measurement is a
   * loud error rather than a field that silently does nothing.
   */
  readonly evalDriver?: EvalDriver;
}

/** One measurement + its hooks: what an eval file default-exports. */
export type EvalDefinitionInput<K extends EvalKind> = Pick<
  EvalMeasurements,
  K
> &
  EvalHooks<K>;

/** The branded value {@link defineEval} returns. */
export type EvalDefinition<K extends EvalKind = EvalKind> =
  EvalDefinitionInput<K> & {
    readonly [EVAL_DEFINITION]: true;
  };

/**
 * What a module's default export declares. Total: every answer the runner has to
 * distinguish is a case here, so no caller can forget one.
 */
export type DeclaredEval =
  | { readonly ok: true; readonly kind: EvalKind; readonly spec: unknown }
  | { readonly ok: false; readonly why: "not-a-definition" }
  | { readonly ok: false; readonly why: "declares-nothing" }
  | {
      readonly ok: false;
      readonly why: "declares-several";
      readonly kinds: readonly EvalKind[];
    };

/** The measurement keys, in a fixed order — the one list, read by everything. */
export const EVAL_KINDS: readonly EvalKind[] = [
  "runEval",
  "measure",
  "measureArms",
  "measureTriggerRate",
  "measureSelectionMatrix",
];

/** Whether a value came from {@link defineEval}. */
export function isEvalDefinition(v: unknown): v is EvalDefinition {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[EVAL_DEFINITION] === true
  );
}

/**
 * Read a module's default export as a declaration. Pure — this is the whole
 * reason the descriptor is data: the runner answers "what does this file
 * declare?" without executing anything and without spending anything.
 */
export function declaredEval(def: unknown): DeclaredEval {
  if (!isEvalDefinition(def)) return { ok: false, why: "not-a-definition" };
  const rec = def as unknown as Record<string, unknown>;
  const present = EVAL_KINDS.filter((k) => rec[k] !== undefined);
  if (present.length === 0) return { ok: false, why: "declares-nothing" };
  if (present.length > 1)
    return { ok: false, why: "declares-several", kinds: present };
  const kind = present[0];
  if (kind === undefined) return { ok: false, why: "declares-nothing" };
  return { ok: true, kind, spec: rec[kind] };
}

/**
 * The definition a module namespace carries, through the CJS/ESM interop layer.
 *
 * 🔴 THE SECOND `.default` IS NOT DEFENSIVE — it is the only way a TypeScript
 * eval file works, and it was found by a test, not by reading. Three shapes
 * reach this function and they are genuinely different objects:
 *
 *   x.eval.mjs   real ESM        → `mod.default` IS the definition
 *   x.eval.cjs   `module.exports = defineEval(…)`
 *                                → `mod.default` is `module.exports`, the definition
 *   x.eval.ts    `export default …`, transpiled to CJS by tsx
 *                                → `mod.default` is `module.exports`, and the
 *                                  definition sits at `mod.default.default`
 *
 * Measured 2026-08-18: without the unwrap a `.eval.ts` file reported
 * "no `export default defineEval({…})` found" — a correct file, refused, with a
 * message that sent its author looking in the wrong place.
 *
 * Brand-directed rather than shape-directed: it reaches deeper ONLY when the
 * outer value is not a definition, so a definition that happens to carry a
 * `default` field of its own is never skipped over.
 */
export function moduleDefault(mod: unknown): unknown {
  const outer = (mod as { default?: unknown } | undefined)?.default;
  if (isEvalDefinition(outer)) return outer;
  const inner = (outer as { default?: unknown } | undefined)?.default;
  return isEvalDefinition(inner) ? inner : outer;
}

/**
 * Was node pointed STRAIGHT at an eval file? `argv1` is `process.argv[1]`: the
 * path node was started with, which no stray configuration can forge.
 *
 *   node x.eval.mjs                 → the file            → true
 *   vigiles eval x.eval.mjs         → dist/eval-entry.js  → false
 *   node -e 'import("x.eval.mjs")'  → undefined           → false
 *   npx vitest run                  → …/vitest/…/forks.js → false
 *
 * Pure: a fact in, a boolean out.
 */
export function ranAsEntry(argv1: string | undefined): boolean {
  return (
    argv1 !== undefined &&
    isEvalScript(argv1.replaceAll("\\", "/").split("/").pop() ?? "")
  );
}

/** The words shown when someone runs an eval file directly. Asserted by a test:
 *  a refusal that stops a run without saying what to do instead is a ticket. */
export function ranAsEntryRefusal(argv1: string): string {
  const f = basename(argv1);
  return (
    `\`node ${f}\` no longer runs this eval — the file DESCRIBES one.\n` +
    `  An eval file that ran itself spent real money on a plain import, so the work moved\n` +
    `  into \`vigiles eval\`, which is the only thing that runs a description.\n` +
    `  → run it:      npx vigiles eval ${argv1}\n` +
    `  → check syntax without running anything: node --check ${argv1}`
  );
}

/**
 * Declare the eval a file describes. Returns a plain, branded value; it starts
 * nothing, spends nothing, and touches no filesystem.
 *
 * ```js
 * import { defineEval, assertRates } from "vigiles";
 * import { skill } from "vigiles";
 *
 * export default defineEval({
 *   measure: { pluginDir, task: "…", checks: [skill("my:skill")], trials: 3 },
 *   assert: (report) => assertRates(report, { min: 0.6 }),
 * });
 * ```
 *
 * @throws if node was pointed straight at the eval file — see the module doc.
 *   That is the ONE thing this function does besides build a value, and it is
 *   here rather than in each file precisely so that no author can forget it.
 */
export function defineEval<K extends EvalKind>(
  def: EvalDefinitionInput<K>,
): EvalDefinition<K> {
  /* v8 ignore next 3 -- the entry-point branch is exercised through a child process (eval-define.test.ts) */
  const argv1 = process.argv[1];
  if (argv1 !== undefined && ranAsEntry(argv1))
    throw new Error(ranAsEntryRefusal(argv1));
  return { ...def, [EVAL_DEFINITION]: true };
}
