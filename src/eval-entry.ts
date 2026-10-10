/**
 * The program `vigiles eval` runs. Given one eval FILE, it imports the
 * description that file exports and executes the measurement it declares.
 *
 * This module exists so that the eval file does not have to be a program. The
 * old shape put the run in the module body, which made `import()` — the cheapest
 * way to ask "does this parse?" — spend real money (see `core/eval-load-phase.ts`
 * for the measurement and `eval-define.ts` for the shape that replaced it).
 *
 * ## What it does, in order
 *
 *   1. closes the paid tier, imports the file, reopens it — so a leftover
 *      top-level `measure(…)` in a half-migrated file throws with a migration
 *      message instead of quietly billing;
 *   2. reads the default export as a declaration — a pure function of a value,
 *      so "declares nothing" is answered before a cent is spent;
 *   3. honours `skipIf` (exit 77, the runner's loud `⊘ SKIPPED`);
 *   4. runs the one declared measurement, overriding `trials` from
 *      `VIGILES_TRIALS` — which is why no eval file parses env or argv any more;
 *   5. prints the report with the formatter that matches the measurement;
 *   6. fails on a run that executed ZERO trials — the check every file used to
 *      hand-write as `if (report.n === 0) throw`;
 *   7. fails — exit 2, before `assert` — on a `runEval` report with a stub call
 *      no rule answered: such a trial measured an answer nobody wrote, and the
 *      file's own `assert` may not look (most call only `compareArms`);
 *   8. calls `assert(report)`.
 *
 * ## Not a CLI verb
 *
 * `vigiles eval` is unchanged; this is the interpreter it spawns per file, the
 * same way it already spawned `node <file>`. It takes one positional argument
 * and has no flags — every knob stays on `vigiles eval`.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { beginEvalLoad, endEvalLoad } from "./core/eval-load-phase.js";
import {
  declaredEval,
  moduleDefault,
  type EvalDefinition,
  type EvalKind,
} from "./eval-define.js";
import {
  measure,
  measureArms,
  measureTriggerRate,
  runEval,
  formatCheckReport,
  formatEvalReport,
  formatTriggerRateReport,
  type ArmsCheckReport,
  type ArmsMeasureSpec,
  type CheckReport,
  type EvalReport,
  type EvalSpec,
  type MeasureSpec,
  type Metrics,
  type TriggerRateReport,
  type EvalDriver,
  type TriggerRateSpec,
  unansweredInReport,
} from "./eval.js";
import { parseToolStubs } from "./core/eval-spec-parse.js";
import {
  measureSelectionMatrix,
  formatSelectionReport,
  type SelectionReport,
} from "./scan-behavioral.js";
import type { SelectionMatrixSpec } from "./eval-define.js";

/** Every report this entry can produce. */
type AnyReport =
  | EvalReport
  | CheckReport
  | ArmsCheckReport
  | TriggerRateReport
  | SelectionReport;

/**
 * How many trials this run should use, or `undefined` to leave the spec alone.
 * `vigiles eval --trials=N` arrives as `VIGILES_TRIALS`; a spec's own `trials` is
 * the default. Pure — exported for the tests.
 *
 * A non-numeric or non-positive value is IGNORED rather than treated as zero: a
 * typo'd `--trials=` must not silently turn a measurement into a no-op.
 */
export function trialsOverride(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * How many runs a report is built from, or `undefined` when the shape carries no
 * such count. Pure. Every measurement has one, but under two different names and
 * at two different depths, which is exactly why each eval file used to
 * hand-write its own `report.n === 0` check (and why several forgot to).
 */
export function runsIn(report: AnyReport): number | undefined {
  if ("arms" in report) {
    const arms = Object.values(
      report.arms as Record<string, { n?: number; runs?: number }>,
    );
    if (arms.length === 0) return 0;
    return arms.reduce((t, a) => t + (a.n ?? a.runs ?? 0), 0);
  }
  return "n" in report ? report.n : undefined;
}

/**
 * The exit code of an eval file whose report has an unanswered stub call.
 * `vigiles eval` exits with it too. 2, the CLI's "error": the run did not fail
 * an assertion, it produced something that is not a measurement.
 */
export const UNANSWERED_STUB_EXIT_CODE = 2;

/**
 * The author-facing failure when a `runEval` report carries a stub call no rule
 * answered, or undefined. Only `runEval` has `stubs`. Pure — the rule itself is
 * `unansweredInReport`, which the lock's refusal reads too.
 */
export function unansweredFailure(
  kind: EvalKind,
  report: AnyReport,
  spec: unknown,
): string | undefined {
  if (kind !== "runEval") return undefined;
  const stubs = parseToolStubs(
    (spec as { readonly stubs?: unknown }).stubs,
    "runEval",
  );
  return unansweredInReport(report as EvalReport, stubs);
}

/**
 * `evalDriver` is only wired on `measureTriggerRate` — the only measurement with
 * a public driver seam. Naming it beside any other measurement is a mistake the
 * runner REFUSES rather than ignores: a field that silently does nothing would
 * send a Codex user's eval to Claude Code and report the number as theirs.
 */
export function driverMisplaced(
  kind: EvalKind,
  hasDriver: boolean,
): string | undefined {
  if (!hasDriver || kind === "measureTriggerRate") return undefined;
  return (
    `\`evalDriver\` is declared beside \`${kind}\`, which cannot use it.\n` +
    `  Only \`measureTriggerRate\` takes a driver; \`runEval\` and the \`measure\` family always\n` +
    `  drive Claude Code (see docs/harnesses.md, footnote 2). Remove it, or measure trigger rate.`
  );
}

/** Run the one declared measurement. The only place the paid runners are called. */
async function runDeclared(
  kind: EvalKind,
  spec: unknown,
  trials: number | undefined,
  evalDriver: EvalDriver | undefined,
): Promise<AnyReport> {
  const withTrials = <T extends object>(s: T): T =>
    trials === undefined ? s : { ...s, trials };
  switch (kind) {
    case "runEval":
      return runEval(withTrials(spec as EvalSpec<Metrics>));
    case "measure":
      return measure(withTrials(spec as MeasureSpec));
    case "measureArms":
      return measureArms(withTrials(spec as ArmsMeasureSpec));
    case "measureTriggerRate":
      return measureTriggerRate(
        withTrials(spec as TriggerRateSpec),
        evalDriver ? { evalDriver } : {},
      );
    case "measureSelectionMatrix": {
      const { pluginDir, ...opts } = withTrials(spec as SelectionMatrixSpec);
      return measureSelectionMatrix(pluginDir, opts);
    }
  }
}

/** Print a report with the formatter that matches its measurement. */
function printReport(kind: EvalKind, report: AnyReport): void {
  switch (kind) {
    case "runEval":
      console.log(formatEvalReport(report as EvalReport));
      return;
    case "measure":
      console.log(formatCheckReport(report as CheckReport));
      return;
    case "measureArms":
      for (const [name, arm] of Object.entries(
        (report as ArmsCheckReport).arms,
      )) {
        console.log(`\n[arm: ${name}]`);
        console.log(formatCheckReport(arm));
      }
      return;
    case "measureTriggerRate":
      console.log(formatTriggerRateReport(report as TriggerRateReport));
      return;
    case "measureSelectionMatrix":
      console.log(formatSelectionReport(report as SelectionReport));
      return;
  }
}

/**
 * The message for a file that is not a description. Separate from the flow so a
 * test can assert the WORDS — this is the ONLY thing an author sees when their
 * pre-migration eval file stops working, so it has to teach the new shape.
 */
export function notADescriptionMessage(file: string, why: string): string {
  const head = `✗ ${file}: ${why}`;
  return (
    `${head}\n` +
    `  An eval file must default-export a description:\n` +
    `      import { defineEval } from "vigiles";\n` +
    `      export default defineEval({ measureTriggerRate: { …spec… }, assert: (r) => … });\n` +
    `  It must NOT run the eval in the module body — importing such a file spends real\n` +
    `  money, which is why that shape was removed. See docs/harness-testing.md § Eval files.`
  );
}

/** The `why` line for each way a default export can fail to be a declaration. */
export function declarationProblem(d: {
  why: "not-a-definition" | "declares-nothing" | "declares-several";
  kinds?: readonly EvalKind[];
}): string {
  switch (d.why) {
    case "not-a-definition":
      return "no `export default defineEval({…})` found.";
    case "declares-nothing":
      return "`defineEval({…})` declares no measurement (it is empty).";
    case "declares-several":
      return `\`defineEval({…})\` declares ${String(d.kinds?.length ?? 0)} measurements (${(d.kinds ?? []).join(", ")}) — declare exactly one.`;
  }
}

/* v8 ignore start -- the process entry: exercised end-to-end through child processes in eval-entry.test.ts */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) {
    console.error(
      "vigiles: eval-entry expects one eval file. Run `vigiles eval <file>`.",
    );
    process.exit(2);
  }
  const url = pathToFileURL(resolve(file)).href;

  let mod: unknown;
  beginEvalLoad();
  try {
    mod = await import(url);
  } finally {
    endEvalLoad();
  }

  const exported = moduleDefault(mod);
  const declared = declaredEval(exported);
  if (!declared.ok) {
    console.error(notADescriptionMessage(file, declarationProblem(declared)));
    process.exit(1);
  }

  const def = exported as EvalDefinition;

  // A malformed declaration is reported BEFORE `skipIf` runs. Otherwise a file
  // that skips on this machine (no `claude` installed, say) would hide its own
  // misconfiguration until somebody ran it somewhere the capability exists.
  const misplaced = driverMisplaced(
    declared.kind,
    def.evalDriver !== undefined,
  );
  if (misplaced !== undefined) {
    console.error(`✗ ${file}: ${misplaced}`);
    process.exit(1);
  }

  const reason = def.skipIf?.();
  if (typeof reason === "string" && reason !== "") {
    console.log(`SKIPPED: ${reason}`);
    process.exit(77);
  }

  const report = await runDeclared(
    declared.kind,
    declared.spec,
    trialsOverride(process.env["VIGILES_TRIALS"]),
    def.evalDriver,
  );
  printReport(declared.kind, report);

  if (runsIn(report) === 0) {
    console.error(`✗ ${file}: no runs executed (0 trials completed).`);
    process.exit(1);
  }

  const unanswered = unansweredFailure(declared.kind, report, declared.spec);
  if (unanswered !== undefined) {
    console.error(`✗ ${file}: ${unanswered}`);
    process.exit(UNANSWERED_STUB_EXIT_CODE);
  }

  await (def.assert as ((r: AnyReport) => void | Promise<void>) | undefined)?.(
    report,
  );
}

// Only when this module IS the program. Importing it must start nothing either —
// the property this whole change is about applies to the runner as much as to the
// files it runs. (This module is emitted as CommonJS; `require.main` is the CJS
// spelling of "am I the program", and it is exact rather than a path comparison.)
if (require.main === module) void main();
/* v8 ignore stop */
