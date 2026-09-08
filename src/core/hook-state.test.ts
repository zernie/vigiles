/**
 * Runtime-owned named state (vitest). Every check has BOTH halves — it fires on a
 * planted defect AND stays correct on realistic clean input — because the whole
 * point of this feature is hooks whose success looks like silence.
 *
 * The load-bearing tests are the ones that pin the SAFE DIRECTION: a fact that was
 * never recorded, or whose stored timestamp is corrupt, must read as infinitely
 * old so the hook SPEAKS. Every historical failure in this area was a hook that
 * went quiet, so a test that only checks the happy path checks nothing.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  state,
  record,
  stateFact,
  durationSeconds,
  isValidStateKey,
  isStateNeed,
  isStateWrite,
  admissibleWrites,
  HookStateError,
  type StateEntry,
} from "./hook-state.js";
import {
  experimental_defineReact,
  experimental_defineInject,
  experimental_defineHook,
  tools,
  notice,
  nothing,
  run,
  inject,
  allow,
  deny,
  runHookProgram,
  outcomeWrites,
  matchesTool,
  invalidToolPatterns,
  compileHookProgram,
  HookCompileError,
} from "./hook-program.js";
import { gatherContext, type ProviderIO } from "./hook-providers.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const agoEntry = (seconds: number, value = ""): StateEntry => ({
  value,
  at: new Date(NOW - seconds * 1000).toISOString(),
});

function io(store: Record<string, StateEntry> = {}): ProviderIO {
  return {
    exec: () => {
      throw new Error("no exec in this test");
    },
    cwd: "/repo",
    platform: "linux",
    isCI: false,
    readState: (k) => store[k] ?? null,
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

test("durationSeconds parses the four units, and REFUSES anything else", () => {
  assert.equal(durationSeconds("90s"), 90);
  assert.equal(durationSeconds("30m"), 1800);
  assert.equal(durationSeconds("1h"), 3600);
  assert.equal(durationSeconds("12h"), 43200);
  assert.equal(durationSeconds("7d"), 604800);
  // The defect half: a plausible-but-wrong duration must not silently become a
  // number. "1 hour" turning into 1 (second) would make a throttle useless, and
  // turning into 0 or Infinity would make it wrong in one of the two directions
  // this feature exists to control.
  for (const bad of ["1 hour", "1H", "hour", "", "3", "-1h", "1w", "1.h"]) {
    assert.equal(durationSeconds(bad), null, `"${bad}" must not parse`);
  }
});

test("a bad duration THROWS at the freshness test, it does not default", () => {
  const f = stateFact(agoEntry(10), NOW);
  assert.throws(() => f.fresherThan("1 hour" as never), HookStateError);
  assert.throws(() => f.olderThan("" as never), HookStateError);
  // Clean half: a good duration answers.
  assert.equal(f.fresherThan("1h"), true);
});

// ---------------------------------------------------------------------------
// The read view — and the direction of every default
// ---------------------------------------------------------------------------

test("a NEVER-RECORDED fact is infinitely old, so every freshness test lets the hook speak", () => {
  const f = stateFact(null, NOW);
  assert.equal(f.recorded, false);
  assert.equal(f.value, "");
  assert.equal(f.at, "");
  assert.equal(f.ageSeconds, Infinity);
  assert.equal(f.fresherThan("100d"), false, "never recorded is NOT fresh");
  assert.equal(f.olderThan("1s"), true, "never recorded IS stale");

  // 🔴 THE REGRESSION THIS PINS. With `ageSeconds: number | null`, the natural
  // spelling of the same test reads a never-recorded fact as FRESH, because
  // `null < 3600` is true in JavaScript. A hook that had never run would then
  // never run — silently, forever. Assert the arithmetic directly so the reason
  // survives even if someone changes the type back.
  assert.equal((null as unknown as number) < 3600, true, "the footgun is real");
  assert.equal(f.ageSeconds < 3600, false, "Infinity defuses it");
});

test("a recorded fact reports its age, value and instant, and the window boundary is exact", () => {
  const f = stateFact(agoEntry(3600, "claude/hook-state"), NOW);
  assert.equal(f.recorded, true);
  assert.equal(f.value, "claude/hook-state");
  assert.equal(f.ageSeconds, 3600);
  // Exactly at the window is NOT fresher-than (strict <) and IS older-than (>=):
  // the two are exact complements, so no age falls through both.
  assert.equal(f.fresherThan("1h"), false);
  assert.equal(f.olderThan("1h"), true);
  assert.equal(f.fresherThan("2h"), true);
  assert.equal(f.olderThan("2h"), false);
  for (const secs of [0, 1, 3599, 3600, 3601, 999999]) {
    const g = stateFact(agoEntry(secs), NOW);
    assert.notEqual(
      g.fresherThan("1h"),
      g.olderThan("1h"),
      `fresherThan and olderThan must partition at age ${String(secs)}`,
    );
  }
});

test("a CORRUPT timestamp reads as never-recorded (noisy), not as recorded-now (silent)", () => {
  const corrupt = stateFact({ value: "x", at: "not-a-date" }, NOW);
  assert.equal(corrupt.recorded, false);
  assert.equal(corrupt.ageSeconds, Infinity);
  assert.equal(
    corrupt.fresherThan("100d"),
    false,
    "corruption must not silence",
  );
  // Clean half: a well-formed entry is honoured.
  assert.equal(stateFact(agoEntry(5), NOW).recorded, true);
});

test("a clock that went backwards clamps to age 0 rather than going negative", () => {
  const future = stateFact(
    { value: "", at: new Date(NOW + 60_000).toISOString() },
    NOW,
  );
  assert.equal(future.ageSeconds, 0);
  assert.equal(future.fresherThan("1s"), true);
});

// ---------------------------------------------------------------------------
// Keys — the containment property
// ---------------------------------------------------------------------------

test("a key is a NAME, not a path: traversal, hidden files and the reserved sigil are unspellable", () => {
  for (const good of [
    "calendar.synced",
    "retro.nagged",
    "a",
    "A1",
    "x_y-z.1",
    "0",
    "a".repeat(64),
  ]) {
    assert.equal(isValidStateKey(good), true, `"${good}" should be valid`);
  }
  for (const bad of [
    "",
    ".",
    "..",
    "../../settings",
    "a/b",
    "a\\b",
    ".hidden",
    "-flag",
    "_leading",
    "@fired",
    "a b",
    "ключ",
    "a".repeat(65),
    "a\nb",
  ]) {
    assert.equal(isValidStateKey(bad), false, `"${bad}" must be rejected`);
  }
});

test("record()/state() THROW on an invalid key — at the tier the hook's own test runs", () => {
  assert.throws(() => record("../../settings"), HookStateError);
  assert.throws(() => record("@fired"), HookStateError);
  assert.throws(() => state(".."), HookStateError);
  // Clean half: valid keys build the expected declarations.
  assert.deepEqual(record("calendar.synced"), {
    kind: "record",
    name: "calendar.synced",
    value: "",
  });
  assert.deepEqual(record("merge.nagged", "main"), {
    kind: "record",
    name: "merge.nagged",
    value: "main",
  });
  assert.deepEqual(state("calendar.synced"), {
    kind: "state",
    name: "calendar.synced",
  });
  assert.equal(isStateNeed(state("x")), true);
  assert.equal(isStateNeed("git.branch"), false);
  assert.equal(isStateWrite(record("x")), true);
  assert.equal(isStateWrite({ kind: "run", command: "ls" }), false);
});

test("admissibleWrites REFUSES a hand-built write that bypassed record()", () => {
  // The real threat: `record()` throws, but nothing stops a hook returning the
  // object literal directly. The runtime re-checks before it computes any path.
  const smuggled = { kind: "record", name: "../../settings", value: "x" };
  const got = admissibleWrites([record("ok.key"), smuggled, "garbage", null]);
  assert.deepEqual(
    got.ok.map((w) => w.name),
    ["ok.key"],
  );
  assert.equal(got.refused.length, 3);
  assert.ok(got.refused.includes("../../settings"));
  // Clean half: an all-valid list is passed through untouched.
  assert.deepEqual(admissibleWrites([record("a"), record("b")]).refused, []);
});

// ---------------------------------------------------------------------------
// Reading rides `needs` — one declared list for every external input
// ---------------------------------------------------------------------------

test("state() reads through needs/ctx, and ONLY what was declared appears", () => {
  const ctx = gatherContext(
    [state("calendar.synced")],
    io({ "calendar.synced": agoEntry(7200) }),
  );
  const fact = ctx["calendar.synced"];
  assert.equal(typeof fact, "object");
  assert.equal((fact as ReturnType<typeof stateFact>).ageSeconds, 7200);
  assert.equal(
    (fact as ReturnType<typeof stateFact>).fresherThan("12h"),
    true,
    "synced 2h ago is fresh within 12h",
  );
  // Undeclared keys are absent even when the store holds them.
  assert.deepEqual(Object.keys(ctx), ["calendar.synced"]);
  // Defect half: a declared key with nothing in the store is present, and stale.
  const empty = gatherContext([state("calendar.synced")], io());
  assert.equal(
    (empty["calendar.synced"] as ReturnType<typeof stateFact>).recorded,
    false,
  );
});

test("a state() need is never reported as an unknown provider, and reaches no subprocess", () => {
  const throwing: ProviderIO = {
    ...io({ "a.b": agoEntry(1) }),
    exec: () => {
      throw new Error("gathering state must not shell out");
    },
  };
  assert.doesNotThrow(() => gatherContext([state("a.b")], throwing));
});

// ---------------------------------------------------------------------------
// Writing is a DECLARATION — the hook never touches the world
// ---------------------------------------------------------------------------

test("a react that only WITNESSES returns nothing() and still declares its record", () => {
  const hook = experimental_defineReact({
    on: "PostToolUse",
    match: tools("mcp__.*"),
    react: () => nothing(record("calendar.synced")),
  });
  const outcome = runHookProgram(hook, {
    tool_name: "mcp__4f54037d__list_events",
  });
  assert.equal(outcome.kind, "reaction");
  assert.deepEqual(
    outcomeWrites(outcome).ok.map((w) => w.name),
    ["calendar.synced"],
  );
  // Defect half: a tool the hook does not match records NOTHING. A witness that
  // fires on the wrong event is worse than one that never fires, because the
  // fact it writes is false.
  const other = runHookProgram(hook, { tool_name: "Bash" });
  assert.deepEqual(outcomeWrites(other).ok, []);
});

test("records ride notice()/run()/inject() as trailing arguments, and are optional", () => {
  assert.deepEqual(notice("hi").records, []);
  assert.deepEqual(run("ls").records, []);
  assert.deepEqual(inject("ctx").records, []);
  assert.deepEqual(nothing().records, []);
  assert.deepEqual(
    notice("hi", record("a"), record("b")).records.map((w) => w.name),
    ["a", "b"],
  );
  assert.equal(run("ls", record("a")).effect !== undefined, true);
  assert.deepEqual(
    inject("ctx", record("a")).records.map((w) => w.name),
    ["a"],
  );
});

test("an inject reads state and records its own nudge in ONE return", () => {
  const hook = experimental_defineInject({
    on: "UserPromptSubmit",
    needs: [state("calendar.synced"), state("calendar.nagged")] as const,
    produce: (e) => {
      if (e.ctx["calendar.synced"].fresherThan("12h")) return inject("");
      if (e.ctx["calendar.nagged"].fresherThan("3h"))
        return inject("short escalation");
      return inject("FULL BLOCK", record("calendar.nagged"));
    },
  });
  const fresh = runHookProgram(
    hook,
    {},
    {
      "calendar.synced": stateFact(agoEntry(60), NOW),
      "calendar.nagged": stateFact(null, NOW),
    },
  );
  assert.equal(fresh.kind === "injection" && fresh.context, "");
  assert.deepEqual(outcomeWrites(fresh).ok, [], "silence records nothing");

  const nagged = runHookProgram(
    hook,
    {},
    {
      "calendar.synced": stateFact(agoEntry(90000), NOW),
      "calendar.nagged": stateFact(agoEntry(60), NOW),
    },
  );
  assert.equal(
    nagged.kind === "injection" && nagged.context,
    "short escalation",
  );
  assert.deepEqual(
    outcomeWrites(nagged).ok,
    [],
    "the escalation line must NOT move the nag stamp, or it silences the full block",
  );

  const full = runHookProgram(
    hook,
    {},
    {
      "calendar.synced": stateFact(agoEntry(90000), NOW),
      "calendar.nagged": stateFact(null, NOW),
    },
  );
  assert.equal(full.kind === "injection" && full.context, "FULL BLOCK");
  assert.deepEqual(
    outcomeWrites(full).ok.map((w) => w.name),
    ["calendar.nagged"],
    "only the branch that SPEAKS records that it spoke",
  );
});

test("a GATE cannot record: a Decision carries no writes, in either direction", () => {
  const gate = experimental_defineHook({
    on: "PreToolUse",
    needs: [state("deploy.done")] as const,
    decide: (e) =>
      e.ctx["deploy.done"].fresherThan("1h") ? allow() : deny("no"),
  });
  for (const fact of [stateFact(agoEntry(10), NOW), stateFact(null, NOW)]) {
    const outcome = runHookProgram(
      gate,
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { "deploy.done": fact },
    );
    assert.equal(outcome.kind, "decision");
    assert.deepEqual(outcomeWrites(outcome).ok, []);
  }
  // Clean half: the gate still DECIDES on the state it read.
  const allowed = runHookProgram(
    gate,
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { "deploy.done": stateFact(agoEntry(10), NOW) },
  );
  assert.equal(allowed.kind === "decision" && allowed.decision.kind, "allow");
});

// ---------------------------------------------------------------------------
// The two routing defects the dogfood exposed
// ---------------------------------------------------------------------------

test("matchesTool follows the SAME regex semantics as the matcher the compiler emits", () => {
  // The defect: an exact-string filter drops a family matcher the harness routes.
  assert.equal(
    matchesTool(["mcp__.*"], "mcp__4f54037d-0499__list_events"),
    true,
    "a family matcher must match a member",
  );
  assert.equal(matchesTool(["Edit", "Write"], "Edit"), true);
  assert.equal(matchesTool(["Edit", "Write"], "Read"), false);
  // Anchored: a pattern must not match a LONGER name by accident.
  assert.equal(matchesTool(["Edit"], "EditNotebook"), false);
  assert.equal(matchesTool(["mcp__.*"], "not_mcp__x"), false);
  // A literal name containing metacharacters still matches itself (includes-first).
  assert.equal(matchesTool(["a(b"], "a(b"), true);
  // An EMPTY declaration matches nothing — including the empty tool name a
  // tool-less event carries. `^()$` matches "", so without an explicit guard
  // `tools()` becomes a catch-all on precisely the events with no tool.
  assert.equal(matchesTool([], ""), false);
  assert.equal(matchesTool([], "Edit"), false);
});

test("a tool pattern that is not a valid regex does NOT compile", () => {
  const bad = experimental_defineReact({
    on: "PostToolUse",
    match: tools("a(b"),
    react: () => nothing(),
  });
  assert.deepEqual(invalidToolPatterns(["a(b", "Edit", "mcp__.*"]), ["a(b"]);
  assert.throws(
    () => compileHookProgram("import {} from 'vigiles/hook';", bad),
    HookCompileError,
  );
  // Clean half: a valid family pattern compiles.
  const good = experimental_defineReact({
    on: "PostToolUse",
    match: tools("mcp__.*"),
    react: () => nothing(),
  });
  assert.doesNotThrow(() =>
    compileHookProgram("import {} from 'vigiles/hook';", good),
  );
});

test("a react on a TOOL-LESS event fires; one that declared tools still filters", () => {
  const stopHook = experimental_defineReact({
    on: "Stop",
    react: () => notice("substantive session"),
  });
  const outcome = runHookProgram(stopHook, { stop_hook_active: false });
  assert.equal(outcome.kind, "reaction");
  assert.equal(
    outcome.kind === "reaction" && outcome.reaction.kind,
    "notice",
    "a Stop react used to return none() forever — the hook was dead",
  );
  // …and it emits no tool matcher, like every other tool-less role.
  const compiled = compileHookProgram(
    "import {} from 'vigiles/hook';",
    stopHook,
  );
  const block = JSON.parse(compiled.settingsBlock) as {
    hooks: Record<string, { matcher?: string }[]>;
  };
  assert.equal(block.hooks.Stop[0].matcher, undefined);

  // Defect half: omitting `match` must not turn every react into a catch-all.
  const toolHook = experimental_defineReact({
    on: "PostToolUse",
    match: tools("Edit"),
    react: () => notice("edited"),
  });
  assert.equal(
    runHookProgram(toolHook, { tool_name: "Bash" }).kind === "reaction" &&
      (
        runHookProgram(toolHook, { tool_name: "Bash" }) as {
          reaction: { kind: string };
        }
      ).reaction.kind,
    "none",
  );
});
