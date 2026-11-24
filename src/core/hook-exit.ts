/**
 * What one run of a compiled hook CAME TO, and the one function that turns it
 * into the process's exit code.
 *
 * 🔴 EXIT 2 IS A HOOK'S OWN DECISION, NEVER THE RUNTIME'S STATE. The harness
 * reads exit 2 as "block this": the tool call is refused, the prompt is erased,
 * the turn goes on. Before this module the runtime also exited 2 when IT broke —
 * a stamp that no longer matched, a hook that would not load, a throw — and on
 * a prompt event that locked the human out of their own session (2026-11: an
 * `inject` hook on `UserPromptSubmit`, edited and not recompiled, refused every
 * prompt). A failure is not a verdict about the action that happened to arrive,
 * so it exits 1, which every harness reads as a NON-blocking error; what a
 * failure does to the action is the wiring's per-hook policy (`onFailure` on
 * Claude Code, written by `vigiles compile` from the hook's role), not ours.
 *
 * By construction, not by convention: the runtime builds one
 * {@link HookRunOutcome} and exits with {@link hookExitCode} of it, in one
 * place. The only `blocked` outcome comes from {@link decidedBlock}, which the
 * runtime calls on exactly one path — a gate's `decide` returned `deny`.
 *
 * Zero imports on purpose: the CLI shim reaches for it when `hook-runtime.js`
 * itself failed to load, so it must cost nothing and depend on nothing.
 */

/** A run that reached an answer, and a run that broke before it could. */
export type HookRunOutcome =
  /** The hook's own `decide` returned deny (or block): the action is refused. */
  | { readonly kind: "blocked" }
  /** Anything else the hook decided or said — allow, ask, observe, inject, react, a repair let through. */
  | { readonly kind: "passed" }
  /**
   * The runtime could not get an answer out of the hook. `cause` and `fix`
   * become the one stderr line a harness shows for a non-blocking error.
   */
  | { readonly kind: "failed"; readonly cause: string; readonly fix: string };

/** A run that broke before the hook answered. */
export type HookRunFailure = Extract<HookRunOutcome, { kind: "failed" }>;

/** Every exit code the hook runtime can end with. */
export type HookExitCode = 0 | 1 | 2;

/** The only constructor of a blocking outcome — call it from a gate's deny and nowhere else. */
export function decidedBlock(): HookRunOutcome {
  return { kind: "blocked" };
}

/** The outcome of a run that answered without blocking. */
export const PASSED: HookRunOutcome = { kind: "passed" };

/** A run that broke: what went wrong, and what makes it right. */
export function failed(cause: string, fix: string): HookRunFailure {
  return { kind: "failed", cause, fix };
}

/**
 * The exit code for an outcome — the ONE place it is computed. blocked → 2,
 * passed → 0, failed → 1 (a harness's non-blocking error).
 */
export function hookExitCode(outcome: HookRunOutcome): HookExitCode {
  switch (outcome.kind) {
    case "blocked":
      return 2;
    case "passed":
      return 0;
    case "failed":
      return 1;
  }
}

/**
 * The one stderr line a failed run prints. One line, because Claude Code shows
 * a non-blocking error's stderr in the transcript as a single notice; the cause
 * and the fix both have to be in it.
 */
export function failureLine(
  hookFile: string | undefined,
  outcome: HookRunFailure,
): string {
  const who = hookFile === undefined ? "hook runtime" : `hook ${hookFile}`;
  return oneLine(
    `vigiles: ${who} failed — ${outcome.cause}. Fix: ${outcome.fix}.`,
  );
}

/** `text` on one line: a thrown message (Node's "Require stack:") folded in, not cut off. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}
