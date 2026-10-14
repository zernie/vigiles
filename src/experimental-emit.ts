/**
 * ⚠️ EXPERIMENTAL — the EMIT delivery for a typed result: the skill CALLS a tool
 * carrying its outcome instead of ENDING its turn with a fenced block.
 *
 * ## Why this exists
 *
 * A typed `output` (an `OutputContract`) is valid only on a forked skill: compile
 * hard-errors `output-without-fork` on the other 31, because an inline skill is
 * spliced into the conversation, has no call→return boundary, and therefore has
 * no return value to type (`research/spec-syntax-and-railway-scope.md`).
 *
 * A TOOL CALL needs no return boundary. The skill does not return the structure —
 * it EMITS it, mid-conversation, and the call lands in `Trace.toolCalls`. So the
 * objection that grounds the exclusion does not apply to this delivery. Same
 * `OutputContract`; a different way of getting it out.
 *
 * ## What is UNPROVEN (why the `experimental_` prefix is on every runtime export)
 *
 *  1. **N=8, one skill, one model.** Measured 2026-08-13 against `paper-status`
 *     (unforked; `allowed-tools: Bash, Read, Grep, Glob`) on sonnet: 8 runs, 8
 *     emits, all on the `ok` track, all parsing against the contract, none
 *     repeated. That answers "does it land at all" and nothing about the rate —
 *     8 of 8 bounds the true failure rate at about 31%, which is not evidence of
 *     reliability. Raw arguments + the free re-scorer:
 *     `examples/experimental-emit/`.
 *  2. **Nobody depends on it.** Neither `compileSkill` nor `compileAgent` emits
 *     this instruction; the caller pastes `.instruction` into a skill body and
 *     serves `.tool` from their own MCP server by hand. There is no compile-time
 *     path, so no skill in any corpus is typed by it yet.
 *  3. **The transport is not part of the contract.** MCP is how the tool reached
 *     the model in the measurement. Whether a plugin can hand the model a tool
 *     WITHOUT a separate server process is untested, and the answer changes what
 *     this surface should look like.
 *  4. **The runtime does not enforce `required`.** Measured: Claude Code accepted a
 *     call omitting three declared-required fields (raw proof in `mine`,
 *     `vigiles/repro/output-contract-2026-08-13/mcp-arm/schema-probe-emitted.jsonl`).
 *     `inputSchema` is DESCRIPTION for the model, not a runtime gate — which is
 *     exactly why `experimental_parseEmitted` re-validates on the receiving side
 *     and why "the API validates it for you" must not be claimed.
 *
 * ## What would have to be true to drop the prefix
 *
 *  - A rate, not an existence proof: ≥30 trials across ≥2 unforked skills and ≥2
 *    models, with the emit-landing rate reported and its failure modes named.
 *  - One consumer inside vigiles that compiles the instruction from the spec, so
 *    the tool name and the shape cannot drift apart by hand.
 *  - A measured answer to (3) — plugin-served tool vs external MCP server — since
 *    an in-process tool would remove the standing-up cost this surface assumes.
 *
 * Until then: not covered by the stability guarantee, may change or be removed
 * without a major bump. See `docs/../STABILITY.md` and `src/experimental.ts`.
 *
 * @experimental
 * @module
 */

import type { OutputContract, OutputFieldType, Shape } from "./core/spec.js";
import type { ToolCall } from "./core/harness-driver.js";
import {
  shapeError,
  type ParsedAgentResult,
} from "./adapters/claude-code/agent-result.js";

/** The default tool name, when `options.name` is not given. */
const DEFAULT_EMIT_TOOL = "emit_result";

/** A JSON-Schema fragment for one declared field. */
export type EmitFieldSchema =
  | { readonly type: "string" }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: { readonly type: "string" } }
  // A declared enum. Structurally identical to `EmitTrackSchema` and deliberately kept
  // separate: that one is the fixed `ok`/`err` discriminator this module owns, this one
  // is whatever the skill author declared, and collapsing them would let a change to the
  // discriminator silently widen every author's enum.
  | { readonly type: "string"; readonly enum: readonly string[] };

/** The `track` discriminator's schema — the enum this module owns, not the author's. */
export interface EmitTrackSchema {
  readonly type: "string";
  readonly enum: readonly ["ok", "err"];
}

/** Anything that can sit under `properties`: a field, the discriminator, a track. */
export type EmitPropertySchema =
  | EmitFieldSchema
  | EmitTrackSchema
  | EmitObjectSchema;

/** A JSON-Schema object node — one track's payload, or the whole argument. */
export interface EmitObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, EmitPropertySchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** An MCP tool definition, in the shape a `tools/list` response carries. */
export interface EmitToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EmitObjectSchema;
}

/** What `experimental_emitTool` hands back: the tool, and the prose that asks for it. */
// eslint-disable-next-line local/no-group-names -- the type of the experimental_emitTool export, not a rule group
export interface ExperimentalEmitTool {
  /** Serve this from your MCP server's `tools/list`. */
  readonly tool: EmitToolDefinition;
  /**
   * Markdown fragment for the skill body. The SAME contract rendered for the
   * model — kept next to the schema so the two cannot drift when hand-wired.
   */
  readonly instruction: string;
}

function fieldSchema(type: OutputFieldType): EmitFieldSchema {
  // An enum reaches the model as a JSON-Schema `enum`, which is the whole point: the
  // permitted values travel WITH the tool definition instead of living in prose the
  // model may or may not have read.
  if (typeof type !== "string") return { type: "string", enum: [...type] };
  switch (type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string[]":
      return { type: "array", items: { type: "string" } };
    default:
      // 🔴 Unreachable from TypeScript, reachable from JavaScript — and the one
      // shipped example of this API (examples/experimental-emit/run-emit.mjs) is
      // .mjs, so this is the path a real author takes.
      //
      // Without this arm the switch fell through to `undefined`, and every later
      // step read that as a field: `"actions" in properties` is TRUE for an
      // undefined value, so nothing noticed; `JSON.stringify` then DROPPED the
      // key while `required` kept it and `additionalProperties: false` forbade
      // it. The served schema demanded a property it also banned — unsatisfiable,
      // silent, and contradicted by `.instruction`, which still asked the model
      // to send it. Throwing here makes the contradiction impossible to construct
      // instead of merely unlikely.
      throw new TypeError(
        `experimental_emitTool: unsupported field type ${JSON.stringify(type)}. ` +
          `Supported: "string", "number", "boolean", "string[]". ` +
          `Nested objects and enums are outside this surface's ceiling — flatten the field, ` +
          `or use the fenced fork rail if the shape cannot be flattened.`,
      );
  }
}

function trackSchema(shape: Shape): EmitObjectSchema {
  const properties: Record<string, EmitFieldSchema> = {};
  for (const [field, type] of Object.entries(shape)) {
    properties[field] = fieldSchema(type);
  }
  return {
    type: "object",
    properties,
    required: Object.keys(shape),
    additionalProperties: false,
  };
}

/** Render a declared shape the way the fenced contract renders it, for the prose half. */
function renderShape(shape: Shape): string {
  const fields = Object.entries(shape)
    .map(([k, t]) => `"${k}": ${t}`)
    .join(", ");
  return fields ? `{ ${fields} }` : "{}";
}

/**
 * ⚠️ EXPERIMENTAL. Derive an emit TOOL from an `OutputContract` — the same
 * contract the fork rail renders as a `vigiles:ok` / `vigiles:err` fenced block.
 *
 *   const emit = experimental_emitTool(contract);
 *   // emit.tool        → serve from your MCP server
 *   // emit.instruction → paste into the (unforked) skill's body
 *
 * The two tracks are NESTED (`{ track, ok? , err? }`), not flattened into one bag
 * of fields. That is deliberate: a flat union cannot say which fields are required
 * on which track, so "success fields mixed with error fields" would be a
 * well-formed call. Nested, it is not expressible.
 *
 * 🔴 `required` in the returned schema is DESCRIPTION, not enforcement — measured,
 * see the module header (4). Validate what arrives with
 * `experimental_parseEmitted`.
 *
 * @experimental
 */
export function experimental_emitTool(
  contract: OutputContract,
  options: { readonly name?: string } = {},
  // eslint-disable-next-line local/no-group-names -- the type of the experimental_emitTool export, not a rule group
): ExperimentalEmitTool {
  const name = options.name ?? DEFAULT_EMIT_TOOL;
  const tool: EmitToolDefinition = {
    name,
    description:
      "Emit this task's structured result. Call this exactly once. Set " +
      '`track` to "ok" and fill `ok` on success, or "err" and fill `err` on ' +
      "failure. Do not call it twice and do not fill both tracks.",
    inputSchema: {
      type: "object",
      properties: {
        track: { type: "string", enum: ["ok", "err"] },
        ok: trackSchema(contract.ok),
        err: trackSchema(contract.err),
      },
      required: ["track"],
      additionalProperties: false,
    },
  };
  const instruction = [
    "## Output contract",
    "",
    `Emit your result by calling the \`${name}\` tool exactly once, at the point`,
    "you have the answer. Do not print it as a code block; the call IS the result.",
    "",
    `On success: \`track: "ok"\`, with \`ok\` =`,
    "",
    "```json",
    renderShape(contract.ok),
    "```",
    "",
    `On failure: \`track: "err"\`, with \`err\` =`,
    "",
    "```json",
    renderShape(contract.err),
    "```",
  ].join("\n");
  return { tool, instruction };
}

/** Does this observed tool name refer to `name` (bare, or MCP-prefixed)? */
function isEmitCall(observed: string, name: string): boolean {
  return observed === name || observed.endsWith(`__${name}`);
}

/**
 * ⚠️ EXPERIMENTAL. Read the emitted result out of a run's tool calls, validated
 * against the contract. Pure — returns the same `ParsedAgentResult` vocabulary the
 * fenced rail's `parseAgentResult` returns, so an eval `measure` can use it as a
 * metric and the assertion below can wrap it, without one dual-purpose function.
 *
 * Accepts `Trace["toolCalls"]`, `SubagentTrace["toolCalls"]` or an eval
 * `ctx.toolCalls`. Names are matched bare (`emit_result`) or MCP-prefixed
 * (`mcp__<server>__emit_result`).
 *
 * Differs from the fenced rail in ONE deliberate way: **more than one call is
 * `malformed`, not last-one-wins.** The fenced parser takes the LAST block because
 * an earlier block may be illustrative reasoning; a tool call is an action, never
 * illustrative, so "exactly once" is checkable here and is not checkable there.
 *
 * @experimental
 */
export function experimental_parseEmitted(
  toolCalls: readonly ToolCall[],
  contract: OutputContract,
  options: { readonly name?: string } = {},
): ParsedAgentResult {
  const name = options.name ?? DEFAULT_EMIT_TOOL;
  const all = toolCalls.filter((c) => isEmitCall(c.name, name));

  // 🔴 A CALL THAT ERRORED IS NOT AN EMISSION, AND USED TO PARSE AS ONE.
  //
  // Measured 2026-08-19: a permission-denied call carrying a perfectly valid payload
  // returned `{"kind":"ok", …}`, because this function filtered by NAME and never looked
  // at `ToolCall.isError` — a field that has been on the type all along. The call never
  // reached the server; the reader reported success. That is the exact shape of defect
  // this channel exists to remove from the fenced rail, reproduced inside the channel.
  //
  // Denial is not hypothetical: it is what a wrong `allowedTools` spelling produces, and
  // MCP tool names mangle per host (`mcp__plugin_<plugin>_<server>__emit_result` on Claude
  // Code, two segments on Codex), so mis-spelling it is the likely case, not the exotic one.
  //
  // The errored calls get their OWN branch rather than being dropped or counted, because
  // all three collapses lie in a different direction:
  //   - counting them → this defect, success for a call nobody received;
  //   - dropping them silently → "no tool call in the run", which sends the reader to the
  //     skill's instructions when the fault is in permissions;
  //   - lumping them with "called twice" → a model that retries a denied call produces a
  //     true signal under a false name. (Observed: two denials in one run.)
  // A successful call ALONGSIDE a denied one is one successful emission; the denial is
  // mentioned, not fatal, because the contract was in fact satisfied.
  // `isError` is a required boolean on ToolCall, so truthiness is exact here.
  const errored = all.filter((c) => c.isError);
  const calls = all.filter((c) => !c.isError);

  if (calls.length === 0) {
    if (errored.length > 0) {
      return {
        kind: "malformed",
        reason:
          `the \`${name}\` call itself errored or was denied ` +
          `(${String(errored.length)} attempt${errored.length === 1 ? "" : "s"}); nothing reached the ` +
          `server, so nothing was emitted. Check the tool's permissions and the exact spelling ` +
          `in \`allowedTools\` — MCP names are host-mangled.`,
      };
    }
    return { kind: "malformed", reason: `no \`${name}\` tool call in the run` };
  }
  if (calls.length > 1) {
    return {
      kind: "malformed",
      reason: `\`${name}\` was called ${String(calls.length)} times; the contract is exactly once`,
    };
  }
  const input = calls[0].input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      kind: "malformed",
      reason: `\`${name}\` call carried no object argument`,
    };
  }
  const args = input as Record<string, unknown>;
  const track = args.track;
  if (track !== "ok" && track !== "err") {
    return {
      kind: "malformed",
      reason: `\`${name}\` call has no \`track\` of "ok" or "err"`,
    };
  }
  const payload = args[track];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {
      kind: "malformed",
      reason: `\`${name}\` call declared track "${track}" but carried no \`${track}\` object`,
    };
  }
  const obj = payload as Record<string, unknown>;
  const bad = shapeError(obj, track === "ok" ? contract.ok : contract.err);
  if (bad) return { kind: "malformed", reason: `${track} payload: ${bad}` };
  return track === "ok"
    ? { kind: "ok", value: obj }
    : { kind: "err", error: obj };
}

/**
 * ⚠️ EXPERIMENTAL. Assert the run emitted a SUCCESS result, and return its value —
 * the emit-channel counterpart of `assertAgentOk`, for a skill that has no return
 * value to assert on.
 *
 * Throws on a missing emit, a repeated emit, an error track, or a payload that
 * does not match the contract. The failure message names every tool the run DID
 * call, because "the skill never emitted" and "the skill emitted the wrong shape"
 * are different bugs and the tool list separates them at a glance.
 *
 * The error track is reachable through `experimental_parseEmitted`; a matching
 * `…EmittedErr` is deliberately NOT shipped while the surface is this young —
 * three exports is the whole prototype.
 *
 * @experimental
 */
export function experimental_assertEmittedOk(
  toolCalls: readonly ToolCall[],
  contract: OutputContract,
  options: { readonly name?: string } = {},
): Record<string, unknown> {
  const r = experimental_parseEmitted(toolCalls, contract, options);
  if (r.kind === "ok") return r.value;
  const why =
    r.kind === "err"
      ? `it emitted an error result: ${JSON.stringify(r.error)}`
      : r.reason;
  const observed = toolCalls.map((c) => c.name).join(", ") || "none";
  throw new Error(
    `expected an emitted success result, but ${why} (tools called: ${observed})`,
  );
}
