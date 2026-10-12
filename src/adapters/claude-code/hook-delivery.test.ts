/**
 * Hook-output delivery on Claude Code — the real capability table gives the
 * DOCUMENTED verdicts (unit tier, nothing spawned).
 *
 * Each case is one sentence of code.claude.com/docs/en/hooks (read 2026-10-11):
 * - § Exit code 0: "Claude never sees stderr from a hook that exits 0. [...] To
 *   surface a warning to Claude from a `PostToolUse` or `PostToolUseFailure`
 *   hook, exit 2 instead so Claude sees the stderr even though the tool already
 *   ran."
 * - § Exit code 0: "For most events, Claude Code writes stdout to the debug log
 *   [...]. The exceptions are `UserPromptSubmit`, `UserPromptExpansion`,
 *   `SessionStart`, and `PostModelSwitch`, where Claude Code adds plain-text
 *   stdout as context".
 * - § Exit code 2 behavior per event: `SessionStart` — "Shows stderr to user only".
 * - § JSON output, universal fields: `continue` — "If `false`, Claude stops
 *   processing entirely after the hook runs"; "Every event accepts them, but
 *   some events discard them [...]. Each event's section says so." § PreCompact
 *   and § Notification each say they discard `continue`.
 *
 * The agnostic logic is tested once in src/core/hook-delivery.test.ts; this
 * pins the TABLE. The Codex twin is ../codex/hook-delivery.test.ts.
 */
import { describe, it, expect } from "vitest";
import { hookOutputDelivery } from "../../core/hook-delivery.js";
import { claudeCodeEventCapabilities } from "./event-capability.js";
import { claudeCodeHookProtocol } from "./hook-protocol.js";

const facts = {
  table: claudeCodeEventCapabilities,
  blockExitCode: claudeCodeHookProtocol.blockExitCode,
  denyDecisionValues: claudeCodeHookProtocol.denyDecisionValues,
  haltsTurnField: claudeCodeHookProtocol.haltsTurnField,
};

const run = (
  event: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string =>
  hookOutputDelivery({ event, exitCode, stdout, stderr, json: null }, facts)
    .kind;

describe("claude-code: the documented routing", () => {
  it("PostToolUse stderr at exit 0 — the measured defect — is undelivered", () => {
    expect(run("PostToolUse", 0, "", "x".repeat(237))).toBe("undelivered");
  });

  it("PostToolUse stderr at exit 2 is delivered (feedback)", () => {
    expect(run("PostToolUse", 2, "", "fix X")).toBe("delivered");
  });

  it("plain stdout is context on SessionStart and UserPromptSubmit only", () => {
    expect(run("SessionStart", 0, "hi", "")).toBe("delivered");
    expect(run("UserPromptSubmit", 0, "hi", "")).toBe("delivered");
    expect(run("PostToolUse", 0, "hi", "")).toBe("undelivered");
    expect(run("Stop", 0, "hi", "")).toBe("undelivered");
  });

  it("SessionStart exit 2 stderr goes to the user only", () => {
    expect(run("SessionStart", 2, "", "no")).toBe("undelivered");
  });
});

describe("claude-code: `continue: false` halts the turn on the events that read it", () => {
  const halt = (event: string): string => {
    const json = { continue: false, stopReason: "build failed" };
    return hookOutputDelivery(
      { event, exitCode: 0, stdout: JSON.stringify(json), stderr: "", json },
      facts,
    ).kind;
  };

  it("on SessionStart and PostToolUse, which veto nothing, the halt is BLOCKED", () => {
    expect(halt("SessionStart")).toBe("blocked");
    expect(halt("PostToolUse")).toBe("blocked");
  });

  it("on the veto events too", () => {
    for (const event of ["UserPromptSubmit", "PreToolUse", "Stop"])
      expect(halt(event)).toBe("blocked");
  });

  it("on PreCompact and Notification, which discard `continue`, it is control JSON", () => {
    expect(halt("PreCompact")).toBe("silent");
    expect(halt("Notification")).toBe("silent");
  });
});
