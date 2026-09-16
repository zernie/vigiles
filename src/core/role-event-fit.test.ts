/**
 * (role × event) compatibility — run against the SIX fixtures that measured the
 * hole (2026-09-16). Each `it` below names the letter it reproduces, so a
 * regression says which real defect came back rather than which assertion moved.
 *
 * The suite is also the honest scorecard: three of the six are rejected, one is
 * warned about, one had already been closed by widening `injectableEvents`, and
 * one (d) is NOT a role/event mismatch at all — it is a matcher-emission bug,
 * and pretending this check caught it would be the overclaim the whole table
 * exists to stop.
 */
import { describe, it, expect } from "vitest";
import { checkRoleEventFit } from "./hook-program.js";
import { claudeCodeEventCapabilities as table } from "../adapters/claude-code/event-capability.js";

describe("dead pairs are REJECTED", () => {
  it("(a) a prompt-gate on PreToolUse — reads a prompt the event does not carry", () => {
    // Measured: compiles clean, runs, and allows EVERYTHING, because the absent
    // `prompt` reads as "" and every predicate over "" is false.
    const fit = checkRoleEventFit("prompt-gate", "PreToolUse", false, table);
    expect(fit.kind).toBe("dead");
    expect(fit.kind === "dead" && fit.message).toMatch(/carries tool/);
  });

  it("(b) a stop-gate on SessionStart — exits 2 into an event that ignores it", () => {
    const fit = checkRoleEventFit("stop-gate", "SessionStart", false, table);
    expect(fit.kind).toBe("dead");
  });

  it("(f) a file-gate on Stop — a tool matcher on an event with no tool", () => {
    const fit = checkRoleEventFit("file-gate", "Stop", true, table);
    expect(fit.kind).toBe("dead");
  });

  it("an inject on an event that honours nothing", () => {
    expect(checkRoleEventFit("inject", "SessionEnd", false, table).kind).toBe(
      "dead",
    );
  });
});

describe("(e) a gate on PostToolUse is WARNED about, never rejected", () => {
  it("reports degraded — the deny feeds the model instead of vetoing", () => {
    const fit = checkRoleEventFit("bash-gate", "PostToolUse", true, table);
    expect(fit.kind).toBe("degraded");
    expect(fit.kind === "degraded" && fit.message).toMatch(/FEEDBACK/);
  });

  it("and that is deliberate — this repo ships a hook on that very channel", () => {
    // `refs-nudge` uses PostToolUse exit 2 as a nudge. Failing this pair would
    // break a working, intentional hook: the cry-wolf case, declined on purpose.
    const fit = checkRoleEventFit("bash-gate", "PostToolUse", true, table);
    expect(fit.kind).not.toBe("dead");
  });
});

describe("legal pairs stay legal", () => {
  it.each([
    ["bash-gate", "PreToolUse", true],
    ["file-gate", "PreToolUse", true],
    ["prompt-gate", "UserPromptSubmit", false],
    ["stop-gate", "Stop", false],
    ["inject", "SessionStart", false],
    ["inject", "UserPromptSubmit", false],
    ["react", "PostToolUse", true],
  ] as const)("%s on %s", (kind, on, matcher) => {
    expect(checkRoleEventFit(kind, on, matcher, table).kind).toBe("ok");
  });

  it("(c) a react's notice on PreToolUse — legal since the 2026-09-15 measurement", () => {
    // This was the sixth fixture, and it is no longer a defect: PreToolUse turned
    // out to honour `inject` after all, which is why the table is measured rather
    // than assumed. Kept as a test so a regression in either direction is loud.
    expect(checkRoleEventFit("react", "PreToolUse", true, table).kind).toBe(
      "ok",
    );
  });
});

describe("what we have NOT recorded stays silent", () => {
  it.each(["TaskCompleted", "WorktreeCreate", "Elicitation"])(
    "%s — a real vendor event with no row: no verdict, no accusation",
    (event) => {
      expect(checkRoleEventFit("stop-gate", event, true, table).kind).toBe(
        "unknown",
      );
    },
  );

  it("an adapter with no table at all is never second-guessed", () => {
    expect(
      checkRoleEventFit("prompt-gate", "PreToolUse", false, undefined).kind,
    ).toBe("unknown");
  });
});
