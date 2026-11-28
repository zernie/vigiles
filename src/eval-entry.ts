/**
 * The VERDICTS of an eval run, all pure: how many trials `VIGILES_TRIALS` asks
 * for, whether a declaration is well formed, whether a report counts as a failed
 * run, and the words of each refusal. `./eval-run.ts` runs a description and
 * asks these; the tests ask them directly.
 *
 * The order a run asks them in, and why, is in `./eval-run.ts`.
 */
import type { EvalKind, RemovedEvalKind } from "./eval-define.js";
import type { EvalReport, TriggerRateReport } from "./eval.js";
import {
  unansweredInReport,
  contextInReport,
  unscoredInReport,
} from "./core/eval-report-failures.js";
import { parseToolStubs } from "./core/eval-spec-parse.js";
import { EvalSpecRefusalError } from "./core/regression-case-entries.js";
import { RegressionCaseRefusalError } from "./core/regression-case-refusal.js";
import {
  describeWorkspaceRefusal,
  WorkspaceRefusalError,
} from "./core/workspace.js";
import { regressionCasesOf } from "./eval-spec-shape.js";
import { ContainerRefusalError } from "./eval-container.js";
import type { SelectionReport } from "./scan-behavioral.js";

/** Every report this entry can produce. */
export type AnyReport = EvalReport | TriggerRateReport | SelectionReport;

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
  if ("arms" in report)
    return Object.values(report.arms).reduce((t, a) => t + a.runs, 0);
  return "n" in report ? report.n : undefined;
}

/**
 * The exit code of an eval file whose report has an unanswered stub call. Its
 * own code — not 2 (the CLI's usage error), 1 (a bad declaration, zero runs) or
 * 77 (skip) — so the runner can say WHICH cause it is from a code only this path
 * produces. `vigiles eval` itself exits {@link UNANSWERED_STUB_VERB_EXIT} for it.
 */
export const UNANSWERED_STUB_EXIT_CODE = 78;

/**
 * What `vigiles eval` exits with when a file exited {@link UNANSWERED_STUB_EXIT_CODE}:
 * 2, the CLI's "error" — the run did not fail an assertion, it produced something
 * that is not a measurement. Documented in docs/cli.md.
 */
export const UNANSWERED_STUB_VERB_EXIT = 2;

/** A `runEval` report: every arm carries its unanswered stub calls. */
const isEvalReport = (r: AnyReport): r is EvalReport =>
  "arms" in r &&
  Object.values(r.arms).every((a: object) => "unansweredStubCalls" in a);

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
  if (kind !== "runEval" || !isEvalReport(report)) return undefined;
  const raw =
    typeof spec === "object" && spec !== null && "stubs" in spec
      ? spec.stubs
      : undefined;
  return unansweredInReport(report, parseToolStubs(raw, "runEval"));
}

/**
 * Why a finished run fails before its `assert` runs — with the exit code — or
 * undefined. Two reasons: it ran ZERO trials (exit 1; the check every file used
 * to hand-write), or a stub call went unanswered (exit 2). Pure.
 */
export function runFailure(
  file: string,
  kind: EvalKind,
  report: AnyReport,
  spec: unknown,
): { readonly code: number; readonly message: string } | undefined {
  // Checked before the zero-runs line: a run whose every trial missed its
  // instruction files has zero scored runs, and this is the reason why.
  const integrity = integrityFailure(report);
  if (integrity !== undefined)
    return { code: 1, message: `✗ ${file}: ${integrity}` };
  if (runsIn(report) === 0)
    return {
      code: 1,
      message: `✗ ${file}: no runs executed (0 trials completed).`,
    };
  // `runEval` has already printed the calls in full (to stderr, before its
  // report): this line is the file's verdict, not a second copy of them.
  return unansweredFailure(kind, report, spec) === undefined
    ? undefined
    : {
        code: UNANSWERED_STUB_EXIT_CODE,
        message: `✗ ${file}: stub call(s) went unanswered (listed above) — the report is not a measurement.`,
      };
}

/**
 * Why a `runEval` report's trials are not scored, or undefined: an
 * instruction file missed the model's request, or a regression case's tree
 * could not be scored as the agent left it. Pure.
 */
function integrityFailure(report: AnyReport): string | undefined {
  if (!isEvalReport(report)) return undefined;
  const context = contextInReport(report);
  return context === undefined
    ? unscoredInReport(report)
    : `an instruction file missed the model's request — those trials are not scored.\n${context}`;
}

/**
 * The line of a refusal thrown before any trial — a malformed spec, a
 * workspace or a case that cannot be run — or undefined for any other throw.
 */
export function refusalText(err: unknown): string | undefined {
  if (err instanceof EvalSpecRefusalError)
    return `spec refused —\n${err.message}`;
  if (err instanceof WorkspaceRefusalError)
    return `workspace refused — ${describeWorkspaceRefusal(err.refusal)}`;
  if (err instanceof RegressionCaseRefusalError) return err.message;
  if (err instanceof ContainerRefusalError) return err.message;
  return undefined;
}

/**
 * Read a `runEval` spec's case list, so a malformed one throws its
 * EvalSpecRefusalError before `skipIf` runs. Nothing for another measurement.
 */
export function checkCaseList(kind: EvalKind, spec: unknown): void {
  if (kind === "runEval") regressionCasesOf(spec);
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
    `  Only \`measureTriggerRate\` takes a driver; \`runEval\` always\n` +
    `  drive Claude Code (see docs/harnesses.md, footnote 2). Remove it, or measure trigger rate.`
  );
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
  why:
    | "not-a-definition"
    | "declares-nothing"
    | "declares-several"
    | "removed-kind";
  kinds?: readonly EvalKind[];
  kind?: RemovedEvalKind;
}): string {
  switch (d.why) {
    case "removed-kind":
      return removedKindProblem(d.kind ?? "measure");
    case "not-a-definition":
      return "no `export default defineEval({…})` found.";
    case "declares-nothing":
      return "`defineEval({…})` declares no measurement (it is empty).";
    case "declares-several":
      return `\`defineEval({…})\` declares ${String(d.kinds?.length ?? 0)} measurements (${(d.kinds ?? []).join(", ")}) — declare exactly one.`;
  }
}

/**
 * The rewrite for a file that still declares a key folded into `runEval` in
 * v55. Named, not "declares nothing": the file declares exactly what it used
 * to, under a key that no longer exists, and its author needs the new one.
 */
function removedKindProblem(kind: RemovedEvalKind): string {
  const arms =
    kind === "measureArms" ? "keep `arms`" : "drop `arms` (one arm, `default`)";
  return (
    `\`defineEval({ ${kind}: … })\` was folded into \`runEval\` in v55 — rename the key:\n` +
    `      defineEval({ runEval: { env: { kind: "inherit", reason: "…" }, …the same spec… } })\n` +
    `  \`runEval\` takes \`checks\` as before (${arms}), and needs \`env\`: \`{ kind: "ephemeral" }\`, or\n` +
    `  \`{ kind: "inherit", reason }\` for the HOME and environment ${kind} used. Its default model is\n` +
    `  \`haiku\` where ${kind}'s was \`sonnet\` — set \`model\` to keep measuring the same thing.`
  );
}
