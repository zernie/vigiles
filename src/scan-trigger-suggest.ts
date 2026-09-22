/**
 * audit → the ONE read-vs-run decision. `audit` is a Lighthouse-style LOCAL
 * report: a deterministic READ by default — safe + identical on every OS, nothing
 * executes — NOT a CI step (CI uses `vigiles lint`, the deterministic gate). The
 * executing checks (safety battery, live MCP resolution, skill-firing trigger-rate)
 * run ONLY when there's a human to consent: at a TTY `audit` ASKS once (and
 * remembers in `.vigilesrc.json` `audit.measure`); headless (an agent / `--json` /
 * `--no-interactive` / a pipe) it stays a read + a one-line nudge — never hangs,
 * never silently executes. There is deliberately NO execution flag: automation
 * tests the harness through the `vigiles` testing API + skills (the layered tiers),
 * not through the report verb. The IO (prompt / run / remember) lives in the CLI;
 * this is the pure decision + helpers.
 */

// 🔴 `ModelEnv` / `hasModelAccess` / `isMeteredAccess` USED TO LIVE HERE, and
// their whole body was ONE harness's environment variables (`ANTHROPIC_API_KEY`,
// `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) sitting in the module named for the
// harness-AGNOSTIC read-vs-run decision. They now live in
// `src/adapters/claude-code/model-access.ts` and are reached through
// `HarnessLiveDriver.access`, which every harness answers in its own terms.
//
// This file is in `HARNESS_AGNOSTIC_DETECTORS` (`eslint.config.mjs`), so the
// literal boundary now refuses `ANTHROPIC_` here: they cannot come back.

/** Why the executing checks were skipped (drives the "not run" nudge). */
export type ExecuteSkipReason =
  | "nothing" // no executable surface at all (no hooks / MCP / skills) — no nudge
  | "headless" // an agent / --json / non-interactive / a pipe — no human to consent
  | "remembered-no"; // a sticky .vigilesrc choice said no

/**
 * What `audit` should do about the EXECUTING checks (battery + live MCP +
 * trigger-rate), as ONE bundle:
 * - `run`  — run them now (a remembered yes).
 * - `ask`  — interactive human + something to run + no sticky choice: ask once,
 *            then remember.
 * - `skip` — stay a deterministic read; the `reason` drives a one-line nudge.
 */
export type ExecuteDecision =
  | { readonly kind: "run" }
  | { readonly kind: "ask" }
  | { readonly kind: "skip"; readonly reason: ExecuteSkipReason };

export interface ExecuteEnv {
  /** Is there ANY executable surface — runnable hooks, an own-repo MCP server, or
   *  a model-invocable skill? Nothing to run → never ask, never nudge. */
  readonly hasExecutable: boolean;
  /** Both stdin AND stdout are a terminal (a human who can answer + wait). */
  readonly isTTY: boolean;
  /** `--json` — machine output; stays a read even at a TTY (never prompt). */
  readonly json: boolean;
  /** `--no-interactive` / `--yes` — explicit agent/CI mode (never prompt). */
  readonly noInteractive: boolean;
  /** Sticky remembered choice from `.vigilesrc.json` (`audit.measure`), or undefined. */
  readonly remembered?: boolean;
}

/**
 * Decide what `audit` does with the executing checks. Total + pure; the first
 * matching rule wins. There is NO execution flag — `audit` is a local report, so
 * the executing checks need a human to consent:
 *  1. nothing executable → skip "nothing" (a clean read; no nudge)
 *  2. headless (`--json` / `--no-interactive` / non-TTY — an agent, a pipe, CI) →
 *     skip "headless" (no one to ask; automation uses the `vigiles` testing API)
 *  3. sticky no → skip "remembered-no"
 *  4. sticky yes → run
 *  5. interactive human, no sticky choice → ask (then remember)
 */
export function decideExecute(o: ExecuteEnv): ExecuteDecision {
  if (!o.hasExecutable) return { kind: "skip", reason: "nothing" };
  if (o.json || o.noInteractive || !o.isTTY)
    return { kind: "skip", reason: "headless" };
  if (o.remembered === false) return { kind: "skip", reason: "remembered-no" };
  if (o.remembered === true) return { kind: "run" };
  return { kind: "ask" };
}

/**
 * The one-line "executing checks not run" nudge for a skipped read (the
 * no-silent-skips corollary). Returns null for `nothing` (nothing to run — not a
 * gap). There is no flag to point at — `audit` runs them only interactively, and
 * automation uses the `vigiles` testing API.
 */
export function formatExecuteSkip(reason: ExecuteSkipReason): string | null {
  switch (reason) {
    case "nothing":
      return null;
    case "headless":
      return (
        "\nℹ Executing checks (safety battery · live MCP · skill firing) skipped — " +
        "`audit` runs them only interactively (a terminal). For automation, test the " +
        "harness with the `vigiles` testing API."
      );
    case "remembered-no":
      return (
        "\nℹ Executing checks not run (you disabled them — edit .vigilesrc.json " +
        "`audit.measure` to re-enable)."
      );
  }
}

/**
 * A starter `--prompts` file (the real `TriggerPromptSet` shape: bare skill name
 * → `{ prompts, irrelevant }`). One entry per triggerable skill, with TODO
 * placeholders the user replaces with real requests.
 */
export function scaffoldTriggerPrompts(skillNames: readonly string[]): string {
  const obj: Record<string, { prompts: string[]; irrelevant: string[] }> = {};
  for (const name of skillNames) {
    obj[name] = {
      prompts: [
        `TODO: a request that SHOULD trigger "${name}"`,
        `TODO: a differently-phrased request that should also trigger it`,
      ],
      irrelevant: [
        `TODO: an unrelated request that should NOT trigger "${name}"`,
      ],
    };
  }
  return JSON.stringify(obj, null, 2) + "\n";
}
