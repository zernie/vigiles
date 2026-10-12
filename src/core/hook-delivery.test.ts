/**
 * hookOutputDelivery — did a hook's text reach the model? (unit tier, pure.)
 *
 * The first case is the measured defect, in shape: a PostToolUse hook writes its
 * finding to stderr and exits 0. The rest pin each branch of the verdict.
 *
 * Harness-NEUTRAL on purpose (`test-both-harnesses` rule 3: agnostic core is
 * tested once): the facts below are a FIXTURE table, not an adapter's. That the
 * real tables give the documented verdicts is pinned beside each adapter —
 * `src/adapters/claude-code/hook-delivery.test.ts` and
 * `src/adapters/codex/hook-delivery.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  hookOutputDelivery,
  type DeliveryFacts,
  type HookEmission,
} from "./hook-delivery.js";
import type { EventCapability } from "./event-capability.js";

const row = (
  carries: EventCapability["carries"],
  honours: EventCapability["honours"],
): EventCapability => ({
  carries,
  honours,
  matcher: carries === "tool",
  denyShape: "exit-code",
});

const facts: DeliveryFacts = {
  table: {
    capturedFrom: "fixture",
    events: {
      SessionStart: row("session", ["inject", "stdout-context"]),
      UserPromptSubmit: row("prompt", ["veto", "inject", "stdout-context"]),
      PreToolUse: row("tool", ["veto", "ask", "inject"]),
      PostToolUse: row("tool", ["feedback", "inject"]),
      Stop: row("stop", ["veto", "inject"]),
      SubagentStop: row("stop", ["veto"]),
    },
  },
  blockExitCode: 2,
  denyDecisionValues: ["block", "deny"],
  haltsTurnField: "continue",
};

// A harness with no table: only its legacy injectable list is a fact.
const tableless: DeliveryFacts = {
  table: undefined,
  blockExitCode: 2,
  denyDecisionValues: ["block", "deny"],
  injectableEvents: ["PostToolUse"],
};

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null;

function parseJson(stdout: string): HookEmission["json"] {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const emit = (
  event: string,
  exitCode: number,
  streams: { readonly stdout?: string; readonly stderr?: string },
): HookEmission => ({
  event,
  exitCode,
  stdout: streams.stdout ?? "",
  stderr: streams.stderr ?? "",
  json: parseJson(streams.stdout ?? ""),
});

const ctx = (event: string, text: string): string =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });

describe("the measured defect: stderr + exit 0 on PostToolUse", () => {
  it("is UNDELIVERED, and says which stream and what to do instead", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stderr: "x".repeat(237) }),
      facts,
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
      facts,
    );
    expect(d).toEqual({
      kind: "delivered",
      via: ["exit-code-feedback"],
      stranded: [],
    });
  });
});

describe("the cures deliver", () => {
  it("the same text via additionalContext IS delivered", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stdout: ctx("PostToolUse", "fix X") }),
      facts,
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
      facts,
    );
    expect(d.kind).toBe("delivered");
    expect(d.kind === "delivered" && d.stranded.map((s) => s.stream)).toEqual([
      "stderr",
    ]);
  });
});

describe("a feedback-event decision reason", () => {
  it("JSON decision:block + reason on PostToolUse reaches the model", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, {
        stdout: JSON.stringify({ decision: "block", reason: "fix X" }),
      }),
      facts,
    );
    expect(d.kind === "delivered" && d.via).toEqual(["decision-reason"]);
  });
});

describe("plain stdout is context only where the event says so", () => {
  it("SessionStart / UserPromptSubmit at exit 0: delivered", () => {
    for (const ev of ["SessionStart", "UserPromptSubmit"]) {
      const d = hookOutputDelivery(emit(ev, 0, { stdout: "hello" }), facts);
      expect(d.kind === "delivered" && d.via, ev).toEqual(["plain-stdout"]);
    }
  });

  it("PostToolUse / Stop at exit 0: stranded on stdout", () => {
    for (const ev of ["PostToolUse", "Stop"]) {
      const d = hookOutputDelivery(emit(ev, 0, { stdout: "hello" }), facts);
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
      facts,
    );
    expect(d.kind).toBe("undelivered");
    expect(d.kind === "undelivered" && d.stranded[0].why).toMatch(/USER/);
  });

  it("exit 2 on SessionStart reaches neither the action nor the model", () => {
    const d = hookOutputDelivery(
      emit("SessionStart", 2, { stderr: "no" }),
      facts,
    );
    expect(d.kind).toBe("undelivered");
  });
});

describe("events that do not carry the text", () => {
  it("additionalContext on an event that does not inject is stranded", () => {
    // SubagentStop: inject was never measured, so the table does not claim it.
    const d = hookOutputDelivery(
      emit("SubagentStop", 0, { stdout: ctx("SubagentStop", "x") }),
      facts,
    );
    expect(d.kind).toBe("undelivered");
  });

  it("a veto is BLOCKED, not delivered — a block is not a nudge", () => {
    expect(
      hookOutputDelivery(emit("PreToolUse", 2, { stderr: "no" }), facts).kind,
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
        facts,
      ).kind,
    ).toBe("blocked");
  });
});

describe("exit codes", () => {
  it("plain stdout at a non-zero exit is never context, even where exit 0 would be", () => {
    const d = hookOutputDelivery(
      emit("SessionStart", 1, { stdout: "hi" }),
      facts,
    );
    expect(d.kind).toBe("undelivered");
    expect(d.kind === "undelivered" && d.stranded[0].why).toMatch(/exit 0/);
  });

  it("halting the turn on a veto event is BLOCKED; without a halt field it is not a veto", () => {
    const halt = emit("Stop", 0, {
      stdout: JSON.stringify({ continue: false, stopReason: "run the tests" }),
    });
    expect(hookOutputDelivery(halt, facts).kind).toBe("blocked");
    // A protocol with no halt field: `continue:false` is just control JSON.
    const noHalt: DeliveryFacts = { ...facts, haltsTurnField: undefined };
    expect(hookOutputDelivery(halt, noHalt).kind).toBe("silent");
  });
});

describe("silence", () => {
  it("nothing printed is SILENT, on a known event and an unknown one", () => {
    expect(hookOutputDelivery(emit("PostToolUse", 0, {}), facts).kind).toBe(
      "silent",
    );
    expect(hookOutputDelivery(emit("TaskCompleted", 0, {}), facts).kind).toBe(
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
      facts,
    );
    expect(d.kind).toBe("silent");
  });
});

describe("unknown events", () => {
  it("an event with no table row is UNKNOWN, never a guessed undelivered", () => {
    const d = hookOutputDelivery(
      emit("TaskCompleted", 0, { stderr: "x" }),
      facts,
    );
    expect(d.kind).toBe("unknown");
    expect(d.kind === "unknown" && d.why).toMatch(/no row/);
  });

  it("an input with no event name is UNKNOWN and says so", () => {
    const d = hookOutputDelivery(emit("", 0, { stderr: "x" }), facts);
    expect(d.kind === "unknown" && d.why).toMatch(/hook_event_name/);
  });
});

describe("a harness with no capability table", () => {
  it("additionalContext on a legacy-injectable event is delivered", () => {
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stdout: ctx("PostToolUse", "x") }),
      tableless,
    );
    expect(d.kind === "delivered" && d.via).toEqual(["additional-context"]);
  });

  it("stderr + exit 0 is UNKNOWN there — the claim is not made for it", () => {
    // No table states the exit-0 stderr routing for it, so the verdict refuses
    // to guess (fail-open, like `capabilityOf`).
    const d = hookOutputDelivery(
      emit("PostToolUse", 0, { stderr: "x" }),
      tableless,
    );
    expect(d.kind).toBe("unknown");
  });
});
