/**
 * codexHookProtocol — Codex's hook wire protocol.
 * Finding: it is essentially IDENTICAL to Claude Code's (exit 2 / `decision:block`
 * / `permissionDecision:deny`) — the thin `HookProtocol` port was the right call.
 * The genuine deltas are the env vars a hook receives + the TOML config format
 * (the ENCODING lives in PluginLayout.settings, a codec; the entry SHAPE is
 * `registration`/`mergeRegistrations` below).
 *
 * Context injection (`hookSpecificOutput.additionalContext`) is ALSO shared — same
 * shape, confirmed against the official Codex hooks docs
 * (developers.openai.com/codex/hooks): supported on SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, SubagentStart. (Earlier docs called this "deferred" —
 * it is not.) So vigiles's PostToolUse nudges + SessionStart summary deliver on
 * Codex unchanged. Caveats: Stop/SubagentStop/PreCompact carry no context, and
 * Codex marks a hook run failed if it emits an unsupported field for the event.
 */
import type { HookProtocol } from "../../core/hook-protocol.js";
import { mergeHooksToml } from "../../hook-install.js";

export const codexHookProtocol: HookProtocol = {
  name: "codex",
  blockExitCode: 2,
  denyDecisionValues: ["block", "deny"],
  // Codex matchers are anchored regexes (`matcher = "^Bash$"`), unlike Claude
  // Code's exact tool name / `A|B` alternation.
  matcherStyle: "regex",
  // Events that honor `hookSpecificOutput.additionalContext` on Codex, per the
  // official hooks docs. Includes the events vigiles's shipped hooks use
  // (PostToolUse, SessionStart), so those nudges reach the Codex agent too.
  injectableEvents: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
  ],
  eventEnvVars: [
    "session_id",
    "cwd",
    "hook_event_name",
    "model",
    "turn_id",
    "permission_mode",
    "PLUGIN_ROOT",
  ],
  // Codex is FLAT: `[[hooks.<event>]]` carries one `{matcher?, command}` per
  // entry. Same fact `toTomlEntries` encodes on the merge side.
  registration(on, matcher, command) {
    const entry = matcher === undefined ? { command } : { matcher, command };
    return { hooks: { [on]: [entry] } };
  },
  mergeRegistrations(existing, compiled, managedBy) {
    return mergeHooksToml(
      existing as Parameters<typeof mergeHooksToml>[0],
      compiled as Parameters<typeof mergeHooksToml>[1],
      managedBy,
    ) as Record<string, unknown>;
  },
};
