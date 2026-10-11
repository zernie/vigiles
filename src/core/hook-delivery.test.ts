/**
 * hookOutputDelivery — did a hook's text reach the model? (unit tier, pure.)
 *
 * The first case is the measured defect, byte-for-byte in shape: a PostToolUse
 * hook writes its finding to stderr and exits 0. Every other case pins one row
 * of the host's documented routing (code.claude.com/docs/en/hooks, § Exit code
 * output / § Exit code 0 / § Exit code 2 behavior per event), so a change to the
 * capability table that silently flips a verdict shows up here.
 *
 * Run against the Claude Code table AND against a table-less (Codex-shaped)
 * fact set, because the fallback is a different code path with a different,
 * weaker claim (`test-both-harnesses`).
 */
import { describe, it, expect } from "vitest";
import {
  hookOutputDelivery,
  type DeliveryFacts,
  type HookEmission,
} from "./hook-delivery.js";
import { claudeCodeEventCapabilities } from "../adapters/claude-code/event-capability.js";
import { claudeCodeHookProtocol } from "../adapters/claude-code/hook-protocol.js";
import { codexHookProtocol } from "../adapters/codex/hook-protocol.js";

const cc: DeliveryFacts = {
  table: claudeCodeEventCapabilities,
  blockExitCode: claudeCodeHookProtocol.blockExitCode,
  denyDecisionValues: claudeCodeHookProtocol.denyDecisionValues,
  haltsTurnField: claudeCodeHookProtocol.haltsTurnField,
};

// Codex has no capability table: only the legacy injectable list is a fact.
const codex: DeliveryFacts = {
  table: undefined,
  blockExitCode: codexHookProtocol.blockExitCode,
  denyDecisionValues: codexHookProtocol.denyDecisionValues,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the table-less fallback IS the subject here
  injectableEvents: codexHookProtocol.injectableEvents,
};

const emit = (
  event: string,
  exitCode: number,
  streams: { stdout?: string; stderr?: string },
): HookEmission => {
  const stdout = streams.stdout ?? "";
  const trimmed = stdout.trim();
  let json: HookEmission["json"] = null;
  if (trimmed.startsWith("{")) {
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { event, exitCode, stdout, stderr: streams.stderr ?? "", json };
};

const ctx = (event: string, text: string): string =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });

describe("the measured defect: stderr + exit 0 on PostToolUse", () => {
  it("is UNDELIVERED, and says which stream and what to do instead", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stderr: "x".repeat(237) }),
      cc,
    );
    expect(d.kind).toBe("undelivered");
    if (d.kind !== "undelivered") return;
    expect(d.stranded).toHaveLength(1);
    expect(d.stranded[0].stream).toBe("stderr");
    expect(d.stranded[0].bytes).toBe(237);
    expect(d.stranded[0].why).toMatch(/additionalContext/);
    // PostToolUse honours feedback, so exit 2 is offered as the other cure.
    expect(d.stranded[0].why).toMatch(/exit 2/);
  });

  it("the same text via exit 2 IS delivered (PostToolUse feedback)", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 2, { stderr: "fix X" }),
      cc,
    );
    expect(d).toEqual({
      kind: "delivered",
      via: ["exit-code-feedback"],
      stranded: [],
    });
  });

  it("the same text via additionalContext IS delivered", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stdout: ctx("PostToolUse", "fix X") }),
      cc,
    );
    expect(d.kind).toBe("delivered");
    expect(d.kind === "delivered" && d.via).toEqual(["additional-context"]);
  });

  it("additionalContext AND a stderr copy: delivered, the copy listed as stranded", () => {
    // The shape a compiled react emits on an injectable event.
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, {
        stdout: ctx("PostToolUse", "fix X"),
        stderr: "fix X",
      }),
      cc,
    );
    expect(d.kind).toBe("delivered");
    expect(d.kind === "delivered" && d.stranded.map((s) => s.stream)).toEqual([
      "stderr",
    ]);
  });

  it("JSON decision:block + reason on PostToolUse reaches the model", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, {
        stdout: JSON.stringify({ decision: "block", reason: "fix X" }),
      }),
      cc,
    );
    expect(d.kind === "delivered" && d.via).toEqual(["decision-reason"]);
  });
});

describe("plain stdout is context only where the event says so", () => {
  it("SessionStart / UserPromptSubmit at exit 0: delivered", () => {
    for (const ev of ["SessionStart", "UserPromptSubmit"]) {
      const d = hookOutputDelivery(emit(ev, 0, { stdout: "hello" }), cc);
      expect(d.kind === "delivered" && d.via, ev).toEqual(["plain-stdout"]);
    }
  });

  it("PostToolUse / Stop at exit 0: stranded on stdout", () => {
    for (const ev of ["PostToolUse", "Stop"]) {
      const d = hookOutputDelivery(emit(ev, 0, { stdout: "hello" }), cc);
      expect(d.kind, ev).toBe("undelivered");
      expect(d.kind === "undelivered" && d.stranded[0].stream, ev).toBe(
        "stdout",
      );
    }
  });
});

describe("other exits and events", () => {
  it("a non-blocking error exit (1) never reaches the model", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 1, { stderr: "boom" }),
      cc,
    );
    expect(d.kind).toBe("undelivered");
    expect(d.kind === "undelivered" && d.stranded[0].why).toMatch(/USER/);
  });

  it("exit 2 on SessionStart reaches neither the action nor the model", () => {
    const d = hookOutputDelivery(emit("SessionStart", 2, { stderr: "no" }), cc);
    expect(d.kind).toBe("undelivered");
  });

  it("additionalContext on an event that does not inject is stranded", () => {
    // SubagentStop: inject was never measured, so the table does not claim it.
    const d = hookOutputDelivery(
      emit("SubagentStop", 0, { stdout: ctx("SubagentStop", "x") }),
      cc,
    );
    expect(d.kind).toBe("undelivered");
  });

  it("a veto is BLOCKED, not delivered — a block is not a nudge", () => {
    expect(
      hookOutputDelivery(emit("PreToolUse", 2, { stderr: "no" }), cc).kind,
    ).toBe("blocked");
    expect(
      hookOutputDelivery(
        emit("PreToolUse", 0, {
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "no",
            },
          }),
        }),
        cc,
      ).kind,
    ).toBe("blocked");
  });

  it("plain stdout at a non-zero exit is never context, even where exit 0 would be", () => {
    const d = hookOutputDelivery(emit("SessionStart", 1, { stdout: "hi" }), cc);
    expect(d.kind).toBe("undelivered");
    expect(d.kind === "undelivered" && d.stranded[0].why).toMatch(/exit 0/);
  });

  it("halting the turn on a veto event is BLOCKED; without a halt field it is not a veto", () => {
    const halt = emit("Stop", 0, {
      stdout: JSON.stringify({ continue: false, stopReason: "run the tests" }),
    });
    expect(hookOutputDelivery(halt, cc).kind).toBe("blocked");
    // A protocol with no halt field: `continue:false` is just control JSON.
    const noHalt: DeliveryFacts = { ...cc, haltsTurnField: undefined };
    expect(hookOutputDelivery(halt, noHalt).kind).toBe("silent");
  });

  it("nothing printed is SILENT, on a known event and an unknown one", () => {
    expect(hookOutputDelivery(emit("PostToolUse", 0, {}), cc).kind).toBe(
      "silent",
    );
    expect(hookOutputDelivery(emit("TaskCompleted", 0, {}), cc).kind).toBe(
      "silent",
    );
  });

  it("control-only JSON (an allow decision) is silent, not stranded", () => {
    const d = hookOutputDelivery(
      emit("PreToolUse", 0, {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        }),
      }),
      cc,
    );
    expect(d.kind).toBe("silent");
  });

  it("an event with no table row is UNKNOWN, never a guessed undelivered", () => {
    const d = hookOutputDelivery(emit("TaskCompleted", 0, { stderr: "x" }), cc);
    expect(d.kind).toBe("unknown");
    expect(d.kind === "unknown" && d.why).toMatch(/no row/);
  });

  it("an input with no event name is UNKNOWN and says so", () => {
    const d = hookOutputDelivery(emit("", 0, { stderr: "x" }), cc);
    expect(d.kind === "unknown" && d.why).toMatch(/hook_event_name/);
  });
});

describe("a harness with no capability table (Codex)", () => {
  it("additionalContext on a legacy-injectable event is delivered", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stdout: ctx("PostToolUse", "x") }),
      codex,
    );
    expect(d.kind === "delivered" && d.via).toEqual(["additional-context"]);
  });

  it("stderr + exit 0 is UNKNOWN there — the claim is not made for it", () => {
    // The host doc quoted in hook-delivery.ts is Claude Code's. Codex's docs do
    // not state the exit-0 stderr routing, and it has no table to say it, so
    // the verdict refuses to guess (fail-open, like `capabilityOf`).
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stderr: "x" }),
      codex,
    );
    expect(d.kind).toBe("unknown");
  });
});
