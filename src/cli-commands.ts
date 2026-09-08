/**
 * The canonical vigiles command surface — the SINGLE SOURCE OF TRUTH the
 * self-command-refs dogfood (`src/self-command-refs.test.ts`) cross-references
 * vigiles's OWN docs + comments against, so a renamed/removed command can't
 * leave a stale `vigiles <cmd>` reference rotting in the docs (the cross-ref
 * moat applied to vigiles itself; the cohesive-cli-surface rule).
 *
 * VERBS are typed by a human/agent/CI. HOOK_RUNTIME_KINDS are the hidden runtime
 * entrypoints under `vigiles hook-runtime <kind>`, emitted into hooks configs and
 * never typed by hand. A behavioural test asserts the dispatch (`src/cli-main.ts`)
 * recognizes exactly these, so this list can't silently drift from the code.
 */

/** Human-facing verbs (printed in help; typed by a human/agent/CI). */
export const VERBS = [
  "init",
  "compile",
  "eject",
  "lint",
  "test",
  "eval",
  "audit",
  "generate",
  "hook-runtime",
] as const;

/** Runtime entrypoint kinds under `vigiles hook-runtime <kind>` (emitted, not typed). */
export const HOOK_RUNTIME_KINDS = [
  "run-program",
  "agent",
  "agent-start",
  "agent-done",
  "skill",
  "skill-tool",
  "skill-start",
  "skill-done",
  "run-skill",
  "intercept-tool",
  "guard",
  "action",
  "refs",
  "eval-lock-nudge",
  "effect-enter",
  "effect-exit",
] as const;

export type Verb = (typeof VERBS)[number];
export type HookRuntimeKind = (typeof HOOK_RUNTIME_KINDS)[number];
