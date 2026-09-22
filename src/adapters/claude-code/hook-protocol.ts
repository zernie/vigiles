/**
 * claudeCodeHookProtocol — the Claude Code `HookProtocol`: a hook blocks via exit
 * code 2 or a `permissionDecision: "deny"` / `decision: "block"` JSON decision;
 * the event arrives on stdin. `decideHook` reads the block code + deny values
 * from here. A Codex adapter's `codexHookProtocol` is nearly identical (the same
 * decision model), adding its own `eventEnvVars` (session_id/PLUGIN_ROOT/…).
 */
import type { HookProtocol } from "../../core/hook-protocol.js";
import { claudeCodeHookCondition } from "./hook-condition.js";
import { mergeHooksJson } from "../../hook-install.js";

export const claudeCodeHookProtocol: HookProtocol = {
  name: "claude-code",
  blockExitCode: 2,
  denyDecisionValues: ["block", "deny"],
  eventEnvVars: [],
  // `{"continue": false}` stops the turn outright and returns `stopReason` to
  // the agent — a stronger stop than a per-call deny, and a documented one.
  haltsTurnField: "continue",
  // Events that honor `hookSpecificOutput.additionalContext` (developer-context
  // injection). Covers vigiles's shipped inject hooks (the SessionStart lint
  // summary, the PostToolUse refs / eval-lock nudges) AND the two events added
  // 2026-09-15 after a MEASUREMENT contradicted the assumption below.
  //
  // `PreToolUse` and `Stop` were absent because the port's doc-comment asserted
  // that "a few (Stop, SubagentStop, PreCompact) carry no context on either"
  // harness. That was never measured for Claude Code. Measured on 2.1.273 by
  // emitting `additionalContext` from a hook on each event and reading the
  // model's OWN request back (`requestContains` over a real `runHarnessTest`
  // run, not the hook's stdout): both events DELIVER. The prior list was
  // therefore a self-inflicted gate — the runtime refused to emit a shape the
  // harness would have honored, and the four affected react hooks read as
  // "undeliverable by vocabulary" when they were undeliverable by our choice.
  //
  // HONEST SCOPE: measured HEADLESS (`claude -p`, which is what runHarnessTest
  // drives). Interactive is unverified, and for the `ask` channel the two
  // plausibly differ (headless has nobody to ask) — but `ask` is a GATE
  // channel, not this inject one, so it does not bear on this list.
  // `SubagentStop`/`PreCompact` stay out: not measured, so not claimed.
  injectableEvents: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ],
  // The `if` field: a permission-rule pattern deciding whether the hook is spawned
  // at all. See ./hook-condition.ts — without it a conditional guard was reported
  // as blocking every disaster in the battery.
  condition: claudeCodeHookCondition,
  // Claude Code NESTS: one matcher block holds a list of commands.
  registration(on, matcher, command) {
    const entry =
      matcher === undefined
        ? { hooks: [{ type: "command", command }] }
        : { matcher, hooks: [{ type: "command", command }] };
    return { hooks: { [on]: [entry] } };
  },
  // Delegates to the JSON merge, which is where the measured behaviour and its
  // test suite live (`hook-install.ts` / `hook-install.test.ts`). The port owns
  // WHICH merge; the module owns HOW. The cast is the structural-to-concrete
  // step the core cannot take: `CompiledHooks` is the application layer's type,
  // and a core port may not name it.
  mergeRegistrations(existing, compiled, managedBy) {
    return mergeHooksJson(
      existing as Parameters<typeof mergeHooksJson>[0],
      compiled as Parameters<typeof mergeHooksJson>[1],
      managedBy,
    );
  },
};
