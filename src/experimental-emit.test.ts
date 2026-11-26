/**
 * Tests for the EXPERIMENTAL emit channel (src/experimental-emit.ts): the tool
 * derived from an `OutputContract`, the parse of an observed tool call, and the
 * assertion. Pure — no model, no MCP server; the paid measurement that this
 * surface exists to support is kept in the author's private measurement notes
 * (run `experimental-emit-2026-08-13`).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { experimental_agent } from "./core/spec.js";
const { result } = experimental_agent;
import type { ToolCall } from "./core/harness-driver.js";
import {
  experimental_emitTool,
  experimental_parseEmitted,
  experimental_assertEmittedOk,
  type EmitObjectSchema,
} from "./experimental-emit.js";

/** The verdict shape a pipeline skill records today via `ledger.mjs record`. */
const CONTRACT = result(
  { verdict: "string", count: "number", report: "string" },
  { reason: "string", detail: "string" },
);

function call(name: string, input: unknown): ToolCall {
  return { name, input, resultText: "recorded", isError: false };
}

test("emitTool derives an MCP tool from the same OutputContract as the fenced rail", () => {
  const { tool, instruction } = experimental_emitTool(CONTRACT);

  assert.equal(tool.name, "emit_result");
  // The two tracks are NESTED, so a mixed ok/err bag is not expressible.
  assert.deepEqual(Object.keys(tool.inputSchema.properties), [
    "track",
    "ok",
    "err",
  ]);
  const ok = tool.inputSchema.properties.ok as EmitObjectSchema;
  assert.deepEqual(ok.properties.count, { type: "number" });
  assert.deepEqual(ok.required, ["verdict", "count", "report"]);
  assert.equal(ok.additionalProperties, false);
  // The prose half carries the same fields, so a hand-wired skill cannot drift.
  assert.match(instruction, /"count": number/);
  assert.match(instruction, /emit_result` tool exactly once/);
});

test("emitTool honors a custom tool name in BOTH halves", () => {
  const { tool, instruction } = experimental_emitTool(CONTRACT, {
    name: "record_verdict",
  });
  assert.equal(tool.name, "record_verdict");
  assert.match(instruction, /`record_verdict` tool exactly once/);
});

test("emitTool maps every OutputFieldType, including string[]", () => {
  const { tool } = experimental_emitTool(
    result({ files: "string[]", done: "boolean" }, { reason: "string" }),
  );
  const ok = tool.inputSchema.properties.ok as EmitObjectSchema;
  assert.deepEqual(ok.properties.files, {
    type: "array",
    items: { type: "string" },
  });
  assert.deepEqual(ok.properties.done, { type: "boolean" });
});

test("parseEmitted reads an ok emit off the tool calls, MCP-prefixed name and all", () => {
  const calls = [
    call("Read", { file_path: "paper.md" }),
    call("mcp__spike__emit_result", {
      track: "ok",
      ok: { verdict: "FINDING", count: 3, report: "reviews/status.md" },
    }),
  ];
  const r = experimental_parseEmitted(calls, CONTRACT);
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.kind === "ok" ? r.value.count : null, 3);
});

test("parseEmitted reads the err track against the err shape", () => {
  const r = experimental_parseEmitted(
    [
      call("emit_result", {
        track: "err",
        err: { reason: "crashed", detail: "no build" },
      }),
    ],
    CONTRACT,
  );
  assert.equal(r.kind, "err");
});

test("parseEmitted: no emit at all is malformed, naming the tool", () => {
  const r = experimental_parseEmitted([call("Read", {})], CONTRACT);
  assert.equal(r.kind, "malformed");
  assert.match(
    r.kind === "malformed" ? r.reason : "",
    /no `emit_result` tool call/,
  );
});

test("parseEmitted: TWO emits are malformed, not last-one-wins", () => {
  const twice = [
    call("emit_result", {
      track: "ok",
      ok: { verdict: "FINDING", count: 1, report: "a.md" },
    }),
    call("emit_result", {
      track: "ok",
      ok: { verdict: "FINDING", count: 9, report: "b.md" },
    }),
  ];
  const r = experimental_parseEmitted(twice, CONTRACT);
  assert.equal(r.kind, "malformed");
  assert.match(
    r.kind === "malformed" ? r.reason : "",
    /called 2 times; the contract is exactly once/,
  );
});

test("parseEmitted: a MISSING required field is malformed — the runtime does not check it", () => {
  // Measured against the real runtime: a call omitting declared-required fields
  // is accepted and delivered. Validation has to happen HERE or nowhere.
  const r = experimental_parseEmitted(
    [call("emit_result", { track: "ok", ok: { verdict: "FINDING" } })],
    CONTRACT,
  );
  assert.equal(r.kind, "malformed");
  assert.match(
    r.kind === "malformed" ? r.reason : "",
    /ok payload: missing field "count"/,
  );
});

test("parseEmitted: a WRONG-TYPED field is malformed", () => {
  const r = experimental_parseEmitted(
    [
      call("emit_result", {
        track: "ok",
        ok: { verdict: "FINDING", count: "three", report: "a.md" },
      }),
    ],
    CONTRACT,
  );
  assert.equal(r.kind, "malformed");
  assert.match(
    r.kind === "malformed" ? r.reason : "",
    /field "count" should be number/,
  );
});

test("parseEmitted: a track with no matching payload object is malformed", () => {
  const r = experimental_parseEmitted(
    [call("emit_result", { track: "ok" })],
    CONTRACT,
  );
  assert.equal(r.kind, "malformed");
  assert.match(
    r.kind === "malformed" ? r.reason : "",
    /declared track "ok" but carried no `ok` object/,
  );
});

test("parseEmitted: a bad or absent track discriminator is malformed", () => {
  for (const input of [
    { ok: { verdict: "x" } },
    { track: "maybe" },
    "not-an-object",
  ]) {
    const r = experimental_parseEmitted([call("emit_result", input)], CONTRACT);
    assert.equal(r.kind, "malformed");
  }
});

test("assertEmittedOk returns the value, and names the tools called when it throws", () => {
  const good = [
    call("emit_result", {
      track: "ok",
      ok: { verdict: "FINDING", count: 2, report: "r.md" },
    }),
  ];
  assert.deepEqual(experimental_assertEmittedOk(good, CONTRACT), {
    verdict: "FINDING",
    count: 2,
    report: "r.md",
  });

  assert.throws(
    () =>
      experimental_assertEmittedOk(
        [call("Read", {}), call("Bash", {})],
        CONTRACT,
      ),
    /no `emit_result` tool call.*tools called: Read, Bash/s,
  );
  assert.throws(
    () =>
      experimental_assertEmittedOk(
        [
          call("emit_result", {
            track: "err",
            err: { reason: "crashed", detail: "d" },
          }),
        ],
        CONTRACT,
      ),
    /emitted an error result/,
  );
  assert.throws(
    () => experimental_assertEmittedOk([], CONTRACT),
    /tools called: none/,
  );
});

/**
 * 🔴 REGRESSION — the schema was UNSATISFIABLE and silent, found by dogfooding this
 * surface across five real skills (2026-08-14). A type outside the ceiling fell
 * through `fieldSchema`'s switch to `undefined`; `"actions" in properties` stayed
 * TRUE, so no guard noticed; `JSON.stringify` then dropped the key while `required`
 * kept it and `additionalProperties: false` forbade it. The served schema demanded
 * a property it also banned, and `.instruction` still told the model to send it.
 *
 * TypeScript rejects this call, which is exactly why it needed a runtime test: the
 * one shipped example of this API is `.mjs`, where the compiler is not present.
 */
test("a field type outside the ceiling THROWS rather than serving an unsatisfiable schema", () => {
  const outOfCeiling = result(
    // @ts-expect-error — unreachable from TS, reachable from the .mjs example
    { verdict: "string", actions: "object[]" },
    { reason: "string" },
  );

  assert.throws(
    () => experimental_emitTool(outOfCeiling),
    /unsupported field type "object\[\]".*Supported: "string", "number", "boolean", "string\[\]"/s,
  );

  // The half that made it silent: an undefined value is still an `in` hit, so any
  // check written that way would have passed the broken schema through. Pinned so
  // a future "cheap validation" cannot reintroduce the same blind spot.
  const properties: Record<string, unknown> = {
    verdict: { type: "string" },
    actions: undefined,
  };
  assert.equal("actions" in properties, true);
  const roundTripped = JSON.parse(JSON.stringify({ properties })) as {
    properties: Record<string, unknown>;
  };
  assert.equal("actions" in roundTripped.properties, false);
  assert.deepEqual(Object.keys(roundTripped.properties), ["verdict"]);
});

// ---------------------------------------------------------------------------
// A call that ERRORED is not an emission — the defect this closes, and the three
// collapses it deliberately avoids.
// ---------------------------------------------------------------------------

/** Like `call`, but the host refused it: the payload is present, the server never saw it. */
function deniedCall(name: string, input: unknown): ToolCall {
  return {
    name,
    input,
    resultText: "User denied permission for this tool call",
    isError: true,
  };
}

const GOOD = {
  track: "ok",
  ok: { verdict: "CUT", count: 3, report: "…" },
};

test("a DENIED call is malformed, not ok — it used to parse as a success", () => {
  // Measured 2026-08-19 on the shipped build: this exact input returned
  // {"kind":"ok","value":{…}}, because the reader filtered by NAME and never looked at
  // `isError`. The call never reached the server. Reporting success for it is the same
  // class of lie the emit channel exists to remove from the fenced rail.
  const r = experimental_parseEmitted(
    [deniedCall("emit_result", GOOD)],
    CONTRACT,
  );
  assert.equal(r.kind, "malformed");
  // The reason must send the reader to PERMISSIONS, not to the skill's instructions.
  assert.match(r.reason, /errored or was denied/);
  assert.match(r.reason, /allowedTools/);
  assert.match(r.reason, /nothing reached the/);
});

test("two denials are named as denials, NOT as `called 2 times`", () => {
  // A model that retries a denied call produces a true signal under a false name if the
  // errored calls are counted: "the contract is exactly once" sends the reader hunting a
  // double-emission bug that does not exist.
  const r = experimental_parseEmitted(
    [deniedCall("emit_result", GOOD), deniedCall("emit_result", GOOD)],
    CONTRACT,
  );
  assert.equal(r.kind, "malformed");
  assert.match(r.reason, /2 attempts/);
  assert.doesNotMatch(r.reason, /exactly once/);
});

test("a denial ALONGSIDE a real emission is one emission — the contract was met", () => {
  // Dropping this to malformed would fail a run that did exactly what was asked, and the
  // denial is already visible in the trace for anyone who wants it.
  const r = experimental_parseEmitted(
    [deniedCall("emit_result", GOOD), call("emit_result", GOOD)],
    CONTRACT,
  );
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.value, GOOD.ok);
});

test("no call at all still says NO CALL — denial must not swallow the plain miss", () => {
  // The third collapse: dropping errored calls silently would turn a permissions fault
  // into "the skill never emitted", pointing at the instructions instead of the cause.
  const r = experimental_parseEmitted([], CONTRACT);
  assert.equal(r.kind, "malformed");
  assert.match(r.reason, /no `emit_result` tool call in the run/);
  assert.doesNotMatch(r.reason, /denied/);
});

// ---------------------------------------------------------------------------
// ENUM — the one extension to OutputFieldType, and the measurement behind it.
// ---------------------------------------------------------------------------

const ENUM_CONTRACT = result(
  { verdict: ["CUT", "MERGE", "KEEP"], count: "number" },
  { reason: "string" },
);

test("an enum field reaches the model as a JSON-Schema enum, not as a string", () => {
  // The permitted values must travel WITH the tool definition. Declared as `string`, the
  // vocabulary lives only in prose the model may not have read — measured at 3/19 = 16%
  // compliance, with 3 mutually incomparable invented categories across 3 runs.
  const { tool } = experimental_emitTool(ENUM_CONTRACT);
  const ok = tool.inputSchema.properties.ok as EmitObjectSchema;
  assert.deepEqual(ok.properties.verdict, {
    type: "string",
    enum: ["CUT", "MERGE", "KEEP"],
  });
});

test("a value outside the enum is malformed, and the reason names the choices", () => {
  const bad = experimental_parseEmitted(
    [call("emit_result", { track: "ok", ok: { verdict: "SHIP", count: 1 } })],
    ENUM_CONTRACT,
  );
  assert.equal(bad.kind, "malformed");
  // Rendered as a choice (`"CUT" | "MERGE" | "KEEP"`), never as `CUT,MERGE,KEEP`, which
  // reads like one value rather than a set of them.
  assert.match(bad.reason, /should be "CUT" \| "MERGE" \| "KEEP"/);

  const good = experimental_parseEmitted(
    [call("emit_result", { track: "ok", ok: { verdict: "CUT", count: 1 } })],
    ENUM_CONTRACT,
  );
  assert.equal(good.kind, "ok");
});

test("a non-string in an enum field is malformed too — membership implies the type", () => {
  const r = experimental_parseEmitted(
    [call("emit_result", { track: "ok", ok: { verdict: 7, count: 1 } })],
    ENUM_CONTRACT,
  );
  assert.equal(r.kind, "malformed");
});
