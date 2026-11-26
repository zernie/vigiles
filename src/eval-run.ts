/**
 * The ONE place an eval description runs. `vigiles eval` spawns
 * `src/eval-program.ts`, which calls {@link main} here; the programmatic door
 * `paid_runEval(definition)` calls {@link runDefinition}. Both go through the same
 * function, so the two cannot disagree about a broken trial (vigiles#416).
 *
 * ## What a run does, in order
 *
 *   1. `main` only: enters the runner and imports the file in its LOAD PHASE,
 *      so a leftover top-level runner call in a half-migrated file throws with a
 *      migration message instead of quietly billing (`core/eval-load-phase.ts`);
 *   2. reads the description — a pure function of a value, so "declares
 *      nothing" is answered before a cent is spent;
 *   3. refuses an `evalDriver` beside a measurement that cannot use it, before
 *      `skipIf`, so a file that skips here does not hide its misconfiguration;
 *   4. honours `skipIf` (exit 77, the runner's loud `SKIPPED`);
 *   5. runs the one declared measurement, overriding `trials` from
 *      `VIGILES_TRIALS` — which is why no eval file parses env or argv;
 *   6. prints the report with the formatter that matches the measurement;
 *   7. fails a run that executed ZERO trials, missed its context, or left a stub
 *      call unanswered (`runFailure` in `./eval-entry.ts`);
 *   8. calls `assert(report)`; a throw is a failed run.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { withEvalLoad, withVigilesRunner } from "./core/eval-load-phase.js";
import type { WorkspaceHost } from "./core/workspace.js";
import {
  declaredEval,
  isEvalDefinition,
  moduleDefault,
  type EvalDefinition,
  type EvalKind,
  type SelectionMatrixSpec,
} from "./eval-define.js";
import {
  declarationProblem,
  driverMisplaced,
  notADescriptionMessage,
  runFailure,
  type AnyReport,
} from "./eval-entry.js";
import {
  measureTriggerRate,
  runEval,
  runEvalOnHost,
  type EvalDriver,
  type EvalReport,
  type EvalSpec,
  type TriggerRateReport,
  type TriggerRateSpec,
} from "./eval.js";
import { formatEvalReport, formatTriggerRateReport } from "./eval-format.js";
import {
  measureSelectionMatrix,
  formatSelectionReport,
  type SelectionReport,
} from "./scan-behavioral.js";

/** What {@link runDeclared} runs: the declared measurement and how to run it. */
interface DeclaredRun {
  readonly kind: EvalKind;
  readonly spec: unknown;
  readonly trials: number | undefined;
  readonly evalDriver: EvalDriver | undefined;
  readonly host: WorkspaceHost | undefined;
}

/** Run the one declared measurement. The only place the paid runners are called. */
async function runDeclared({
  kind,
  spec,
  trials,
  evalDriver,
  host,
}: DeclaredRun): Promise<AnyReport> {
  const withTrials = <T extends object>(s: T): T =>
    trials === undefined ? s : { ...s, trials };
  switch (kind) {
    case "runEval": {
      const run = withTrials(spec as EvalSpec);
      return host === undefined ? runEval(run) : runEvalOnHost(run, host);
    }
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
    case "measureTriggerRate":
      console.log(formatTriggerRateReport(report as TriggerRateReport));
      return;
    case "measureSelectionMatrix":
      console.log(formatSelectionReport(report as SelectionReport));
      return;
  }
}

/**
 * How a run of one eval description ended. Every way it can end is a variant, so
 * a caller cannot read "no report" as "passed": `skipped` and `refused` carry
 * their reason, `failed` its exit code.
 *
 * @public
 */
export type EvalOutcome =
  | { readonly kind: "passed"; readonly report: AnyReport }
  | {
      readonly kind: "failed";
      readonly code: number;
      readonly message: string;
      readonly report: AnyReport | undefined;
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "refused"; readonly message: string };

/** The exit code `vigiles eval` gives each outcome. Pure. */
export function exitCodeOf(outcome: EvalOutcome): number {
  switch (outcome.kind) {
    case "passed":
      return 0;
    case "failed":
      return outcome.code;
    case "skipped":
      return 77;
    case "refused":
      return 1;
  }
}

/** What {@link runDefinition} needs besides the description. */
export interface RunDefinitionOptions {
  /** Names the run in every line it prints: the file, or the door. */
  readonly label: string;
  /** Overrides the description's own `trials`. */
  readonly trials: number | undefined;
  /** The machine side of `experimental_workspace`; without it that key is refused. */
  readonly host: WorkspaceHost | undefined;
  /** The message for a value that is not a description. */
  readonly notADescription?: (why: string) => string;
}

/**
 * Run one eval DESCRIPTION — the value an eval file default-exports — and say
 * how it ended. THE ONE place an eval runs: `vigiles eval` (through {@link main})
 * and the programmatic door `paid_runEval(definition)` both call it, so the two
 * cannot disagree about a broken trial (vigiles#416: the old direct call returned
 * a report and exited 0 where the CLI exited 1). It prints what the CLI always
 * printed; it never exits the process and never throws on a failed run.
 */
export async function runDefinition(
  exported: unknown,
  o: RunDefinitionOptions,
): Promise<EvalOutcome> {
  const ready = preflight(exported, o);
  if (ready.kind !== "ready") return ready;
  const { def, measures: kind, spec } = ready;
  const report = await runDeclared({
    kind,
    spec,
    trials: o.trials,
    evalDriver: def.evalDriver,
    host: o.host,
  });
  printReport(kind, report);
  const failure = runFailure(o.label, kind, report, spec);
  if (failure !== undefined)
    return failed(failure.code, failure.message, report);
  return asserted(def, report, o.label);
}

/** A description that passed every check made before a cent is spent. */
interface Ready {
  readonly kind: "ready";
  readonly def: EvalDefinition;
  readonly measures: EvalKind;
  readonly spec: unknown;
}

/**
 * Everything decided before the run: is it a description, is its driver where
 * it can be used, does it skip here. A malformed declaration is reported BEFORE
 * `skipIf` runs, or a file that skips on this machine (no `claude` installed,
 * say) would hide its misconfiguration until someone ran it where it does not.
 */
function preflight(
  exported: unknown,
  o: RunDefinitionOptions,
): EvalOutcome | Ready {
  const declared = declaredEval(exported);
  // `declaredEval` already answers "not a definition"; the guard is how the
  // type learns it too, without a cast.
  if (!declared.ok || !isEvalDefinition(exported)) {
    return notADescription(
      declared.ok ? { why: "not-a-definition" } : declared,
      o,
    );
  }
  const misplaced = driverMisplaced(
    declared.kind,
    exported.evalDriver !== undefined,
  );
  if (misplaced !== undefined) return refused(`✗ ${o.label}: ${misplaced}`);
  return (
    skipped(exported) ?? {
      kind: "ready",
      def: exported,
      measures: declared.kind,
      spec: declared.spec,
    }
  );
}

/** The refusal for a value that is not a well-formed description. */
function notADescription(
  problem: Readonly<Parameters<typeof declarationProblem>[0]>,
  o: RunDefinitionOptions,
): EvalOutcome {
  const why = declarationProblem(problem);
  return refused(
    o.notADescription?.(why) ?? notADescriptionMessage(o.label, why),
  );
}

/** The description's `skipIf`, answered: a reason skips loudly, nothing runs on. */
function skipped(def: EvalDefinition): EvalOutcome | undefined {
  const reason = def.skipIf?.();
  if (typeof reason !== "string" || reason === "") return undefined;
  console.log(`SKIPPED: ${reason}`);
  return { kind: "skipped", reason };
}

/** Run the description's own `assert`; a throw is a failed run, exit 1. */
async function asserted(
  def: EvalDefinition,
  report: AnyReport,
  label: string,
): Promise<EvalOutcome> {
  const assert = def.assert as
    | ((r: AnyReport) => void | Promise<void>)
    | undefined;
  try {
    await assert?.(report);
  } catch (err) {
    const why = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return failed(1, `✗ ${label}: assert failed — ${why}`, report);
  }
  return { kind: "passed", report };
}

function refused(message: string): EvalOutcome {
  console.error(message);
  return { kind: "refused", message };
}

function failed(
  code: number,
  message: string,
  report: AnyReport | undefined,
): EvalOutcome {
  console.error(message);
  return { kind: "failed", code, message, report };
}

/**
 * What `vigiles eval` does with one file: import it inside the runner (its
 * module body in the load phase, where no model may be spawned), run the
 * description it exports, and answer with the exit code. The program root,
 * `src/eval-program.ts`, reads `argv` and the environment and exits with it.
 */
export async function main(
  file: string,
  o: Omit<RunDefinitionOptions, "label">,
): Promise<number> {
  return withVigilesRunner("eval-cli", async () => {
    const mod: unknown = await withEvalLoad(
      () => import(pathToFileURL(resolve(file)).href),
    );
    return exitCodeOf(
      await runDefinition(moduleDefault(mod), { ...o, label: file }),
    );
  });
}
