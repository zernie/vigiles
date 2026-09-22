/**
 * Claude Code's answer to "is a real model reachable, and on whose bill" — the
 * env-only half of `HarnessLiveDriver.access`.
 *
 * 🔴 IT USED TO LIVE IN `src/scan-trigger-suggest.ts`, the module named for the
 * harness-AGNOSTIC read-vs-run decision, and its whole body was one harness's
 * environment variables. The CLI then paired it with a name check for the other
 * harness (`adapter.name === "codex" || hasModelAccess(process.env)`), which is
 * the same fact said twice in two vocabularies. Here it is one adapter's
 * knowledge of its own credentials, and the CLI asks the port.
 *
 * A tiny env-only predicate, never a live probe: deciding whether to offer a
 * measurement must not itself spend a token.
 */

/** Only the env vars that signal a reachable model (parse, don't validate). */
export interface ModelEnv {
  readonly ANTHROPIC_API_KEY?: string;
  readonly CLAUDECODE?: string;
  readonly CLAUDE_CODE_ENTRYPOINT?: string;
}

/**
 * Is a real model reachable for the executing tiers? Either a metered API key
 * (`ANTHROPIC_API_KEY`), OR an authenticated Claude Code session (`CLAUDECODE=1`
 * / `CLAUDE_CODE_ENTRYPOINT`, web/desktop/CLI) — the latter drives the `claude`
 * CLI on the user's subscription, no key needed and $0 metered.
 */
export function hasModelAccess(env: ModelEnv): boolean {
  return Boolean(
    env.ANTHROPIC_API_KEY ||
    env.CLAUDECODE === "1" ||
    env.CLAUDE_CODE_ENTRYPOINT,
  );
}

/**
 * Is the reachable model METERED (a paid API key) rather than a subscription?
 * Only affects the consent DISCLOSURE wording (a metered key bills per token; a
 * subscription is $0 metered) — the run/skip decision itself is consent-driven,
 * not metered-driven.
 */
export function isMeteredAccess(env: ModelEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * The one line printed instead of running, when nothing is reachable. It names
 * THIS harness's CLI and credential — the string it replaces was printed for
 * every harness, so a Codex repo was told to authenticate `claude`.
 */
export const CLAUDE_CODE_ACCESS_FIX =
  "authenticate the `claude` CLI or set ANTHROPIC_API_KEY";
