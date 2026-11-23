/**
 * #396 (a) on Codex's payload. Codex's hooks docs
 * (developers.openai.com/codex/hooks, read 2026-11-17) say shell commands —
 * including unified exec — "Match as `Bash`", that `tool_name` is the
 * "canonical hook tool name, such as `Bash`, `apply_patch`, …", and that "`Bash`
 * and `apply_patch` use `tool_input.command`". The trap is `apply_patch`, whose
 * `tool_input.command` is a PATCH: the core decode keys on the tool name, so a
 * patch is never parsed as a shell command.
 *
 * ⚠️ UNRESOLVED, pinned rather than picked: this adapter's own delivery fixture
 * (./hook-delivery.test.ts) and its dialect (`builtinAgentTools`) spell the
 * shell tool `shell` — Codex's MODEL-facing name. No real Codex hook payload
 * has been captured here, so which spelling the hook receives is a documented
 * claim, not a measurement. Both are covered below; only `Bash` gets a command.
 * The Claude Code twin is ../claude-code/react-command.test.ts.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  experimental_defineReact,
  tools,
  notice,
  nothing,
  runReact,
} from "../../core/hook-program.js";

const pushNotice = experimental_defineReact({
  on: "PostToolUse",
  match: tools("Bash"),
  react: (e) =>
    e.command.runs("git push") ? notice(`pushed: ${e.command.raw}`) : nothing(),
});

const post = (tool_name: string, command: string) => ({
  hook_event_name: "PostToolUse",
  tool_name,
  tool_input: { command },
  tool_response: "",
  cwd: "/repo",
  turn_id: "t-1",
});

test("a Bash-only react sees e.command on a Codex shell payload (unified exec arrives as Bash too)", () => {
  assert.equal(
    runReact(pushNotice, post("Bash", "git push -u origin feature")).kind,
    "notice",
  );
  assert.equal(runReact(pushNotice, post("Bash", "git log -1")).kind, "none");
});

test("apply_patch carries tool_input.command, and it is NOT given a ShellCommand", () => {
  const patch =
    "*** Begin Patch\n*** Update File: a.txt\n@@\n-git push\n+git push --force\n*** End Patch";
  const seen: boolean[] = [];
  const patchReact = experimental_defineReact({
    on: "PostToolUse",
    match: tools("apply_patch"),
    react: (e) => {
      seen.push("command" in e);
      return nothing();
    },
  });
  runReact(patchReact, post("apply_patch", patch));
  assert.deepEqual(seen, [false]);
  // And the Bash-only react does not fire on it: `git push` inside the patch
  // text is not a command that ran.
  assert.equal(runReact(pushNotice, post("apply_patch", patch)).kind, "none");
});

test("a payload spelled `shell` (this adapter's older fixture) is NOT the shell tool today", () => {
  // If Codex really sends `shell` in the hook payload, a `tools("Bash")` react
  // never fires there. Settling it needs a payload captured from the real
  // binary; until then this pins today's behaviour so a change is a decision.
  assert.equal(
    runReact(pushNotice, post("shell", "git push origin main")).kind,
    "none",
  );
});
