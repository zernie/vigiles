/**
 * Hook-output delivery on Codex — the TABLE-LESS path (unit tier).
 *
 * Codex's adapter has no event capability table, so `runHook` judges delivery
 * only where the protocol's own `injectableEvents` proves it (Codex's hooks
 * docs: "That additionalContext text is added as extra developer context",
 * developers.openai.com/codex/hooks, read 2026-10-11). Those docs say nothing
 * about stderr at exit 0, so that verdict is `unknown` — and `assertDelivered`
 * FAILS on unknown rather than passing it (`no-silent-skips`).
 *
 * The Claude Code twin is ../claude-code/hook-delivery.test.ts.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { runHook } from "../../run-hook.js";
import { assertDelivered } from "../../harness-assert.js";
import { codexHookProtocol } from "./hook-protocol.js";

const opts = { protocol: codexHookProtocol };
const postShell = {
  hook_event_name: "PostToolUse",
  tool_name: "shell",
  tool_input: { command: "ls" },
};

test("codex: additionalContext on an injectable event is DELIVERED", () => {
  const r = runHook(
    `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"x"}}'`,
    postShell,
    opts,
  );
  assert.equal(r.delivery.kind, "delivered");
  assertDelivered(r);
});

test("codex: stderr + exit 0 is UNKNOWN — no table claims it — and the assert fails loudly", () => {
  const r = runHook(`printf x >&2; exit 0`, postShell, opts);
  assert.equal(r.delivery.kind, "unknown");
  assert.throws(() => {
    assertDelivered(r);
  }, /cannot be judged/);
});
