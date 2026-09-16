/**
 * Event-capability suite (vitest, unit tier, nothing spawned).
 *
 * The load-bearing half is the DERIVATION block: the three flat lists that
 * existed before this table must be reproducible FROM it, exactly. That is what
 * makes the table a single source rather than a fourth opinion — and it is not
 * ceremony, it already caught one real modelling error (`noEffectHookEvents`
 * means "no effect OF A BLOCK", not "no effect"; reading it as `honours === []`
 * silently dropped SessionStart and would have changed what
 * `hook-block-ineffective` flags).
 */
import { describe, it, expect } from "vitest";
import {
  capabilityOf,
  honoursChannel,
  eventsHonouring,
  blockIneffectiveEvents,
  permissionDecisionEvents,
} from "./event-capability.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { claudeCodeEventCapabilities } from "../adapters/claude-code/event-capability.js";
import { claudeCodeHookProtocol } from "../adapters/claude-code/hook-protocol.js";

const table = claudeCodeEventCapabilities;
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("the classifier is total", () => {
  it("answers `known` for a recorded event", () => {
    const v = capabilityOf(table, "PreToolUse");
    expect(v.kind).toBe("known");
    expect(v.kind === "known" && v.capability.carries).toBe("tool");
  });

  it("answers `unknown` for an event the vendor has but we have not recorded", () => {
    // A REAL Claude Code event (it is in `hookEvents`), deliberately absent from
    // the table — the case the whole partial-table design exists for.
    expect(claudeCodeDialect.hookEvents).toContain("TaskCompleted");
    expect(capabilityOf(table, "TaskCompleted").kind).toBe("unknown");
  });

  it("answers `unknown` for a name that is not an event at all", () => {
    expect(capabilityOf(table, "NotAnEvent").kind).toBe("unknown");
  });

  it("answers `unknown` when the adapter has no table", () => {
    expect(capabilityOf(undefined, "PreToolUse").kind).toBe("unknown");
  });
});

describe("honoursChannel keeps THREE answers", () => {
  it("true / false on a recorded event", () => {
    expect(honoursChannel(table, "PreToolUse", "veto")).toBe(true);
    expect(honoursChannel(table, "PostToolUse", "veto")).toBe(false);
  });

  it("'unknown' — never collapsed into false — on an unrecorded one", () => {
    // Collapsing this to `false` is how a partial table becomes a confident
    // wrong REJECTION at compile time. The three-valued return is the guard.
    expect(honoursChannel(table, "TaskCompleted", "veto")).toBe("unknown");
    expect(honoursChannel(undefined, "PreToolUse", "veto")).toBe("unknown");
  });
});

describe("the flat lists DERIVE from the table (one source, not two truths)", () => {
  it("noEffectHookEvents === events honouring neither veto nor feedback", () => {
    expect(sorted(blockIneffectiveEvents(table))).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the legacy field ON PURPOSE: this asserts the derived table reproduces it exactly, which is what makes them one source
      sorted(claudeCodeDialect.noEffectHookEvents ?? []),
    );
  });

  it("permissionDecisionHookEvents === events whose deny needs the field", () => {
    expect(sorted(permissionDecisionEvents(table))).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the legacy field ON PURPOSE: this asserts the derived table reproduces it exactly, which is what makes them one source
      sorted(claudeCodeDialect.permissionDecisionHookEvents ?? []),
    );
  });

  it("injectableEvents === events honouring inject", () => {
    // This one crosses PORTS — the list lives on hookProtocol, the table on the
    // dialect — which is precisely the split that let them disagree until
    // 2026-09-15, when PreToolUse and Stop turned out to inject after all.
    expect(sorted(eventsHonouring(table, "inject"))).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the legacy field ON PURPOSE: this asserts the derived table reproduces it exactly, which is what makes them one source
      sorted(claudeCodeHookProtocol.injectableEvents),
    );
  });

  it("every recorded event is a real event of the dialect", () => {
    for (const name of Object.keys(table.events))
      expect(claudeCodeDialect.hookEvents).toContain(name);
  });
});

describe("the table's own invariants", () => {
  it("a tool matcher is only ever claimed where the event carries a tool", () => {
    for (const [name, c] of Object.entries(table.events))
      if (c.matcher) expect(c.carries, `${name} claims a matcher`).toBe("tool");
  });

  it("records where it was captured from, version included", () => {
    // The `vocabulary.ts` contract: our staleness is visible to whoever hit it.
    expect(table.capturedFrom).toMatch(/claude-code \d+\.\d+/);
  });
});
