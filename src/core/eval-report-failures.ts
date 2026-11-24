/**
 * The author-facing failures read off a finished eval report — a stub call no
 * rule answered, an instruction file that missed the model's request. Pure: the
 * run pipeline (`src/eval.ts`), its lock and `vigiles eval` all read the same
 * text from here.
 */
import type { EvalReport } from "./eval-report.js";
import { unansweredMessage, type ToolStub } from "./stub-rules.js";
import { contextFailure } from "./context-evidence.js";

/**
 * The author-facing failure for a report whose stubs left a call unanswered, or
 * undefined. One owner for the rule — `vigiles eval`'s exit 2 and the lock's
 * refusal both read it — so a consumer whose `assert` calls no helper still
 * fails. Pure.
 */
export function unansweredInReport(
  report: Pick<EvalReport, "arms">,
  stubs: readonly ToolStub[],
): string | undefined {
  const calls = Object.values(report.arms).flatMap(
    (a) => a.unansweredStubCalls,
  );
  const message = unansweredMessage(calls, stubs);
  return message === undefined
    ? undefined
    : `${message}\n  The report is not a measurement: no lock is written, and \`vigiles eval\` exits 2.`;
}

/**
 * The author-facing failure for a report where an instruction file missed the
 * model's request in some trial, or undefined (vigiles#416). One owner, like
 * {@link unansweredInReport}: the lock's refusal and `vigiles eval` read it.
 */
export function contextInReport(
  report: Pick<EvalReport, "arms">,
): string | undefined {
  const lines = contextFailure(report.arms);
  return lines === undefined
    ? undefined
    : `${lines}\n  Those trials are not scored: no lock is written, and the eval fails.`;
}
