/**
 * vigiles — parse a subagent's railway result.
 *
 * A subagent with a `result()` contract is told (in its compiled system prompt)
 * to end its turn with exactly one fenced block:
 *
 *   ```vigiles:ok
 *   { "files": ["a.ts"], "summary": "done" }
 *   ```
 *
 * or `vigiles:err` for the error track. This module extracts and validates that
 * block — the single primitive the railway orchestrator and the harness-test
 * assertions (`experimental_assertAgentOk`, `check.experimental_agentResult`) both build on. Pure and
 * model-free: hand it the worker's text, get back a discriminated outcome.
 *
 * "Railway-oriented" is literal here: the parse is `text -> Result<S, E>` with a
 * third `malformed` track for a worker that didn't honor its contract (no block,
 * bad JSON, or a shape that doesn't match the declared schema).
 */

import type { OutputContract, OutputFieldType } from "./spec.js";

/**
 * The outcome of parsing a worker's result block.
 *
 * @public
 */
export type ParsedAgentResult<
  S = Record<string, unknown>,
  E = Record<string, unknown>,
> =
  | { readonly kind: "ok"; readonly value: S }
  | { readonly kind: "err"; readonly error: E }
  | { readonly kind: "malformed"; readonly reason: string };

// Capture every vigiles:ok / vigiles:err fenced block; the LAST one is the
// worker's final answer (earlier ones may be illustrative in its reasoning).
// The CLOSING fence must own its line: a ``` inside a JSON string value sits
// mid-line, so it no longer terminates the block (measured 2026-08-13 — a
// contract field carrying a code snippet made every such answer `malformed`
// even though the model's JSON was valid).
const BLOCK_RE =
  /^[ \t]*```vigiles:(ok|err)[ \t]*\r?\n([\s\S]*?)\r?\n^[ \t]*```[ \t]*$/gm;

/** Does a runtime value match a declared field type? */
function fieldMatches(value: unknown, type: OutputFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    default:
      // An enum, declared as a readonly tuple of the permitted literals.
      return typeof value === "string" && type.includes(value);
  }
}

/** How a field type reads in a message to a human: `string`, or `"CUT" | "MERGE"`. */
function typeName(type: OutputFieldType): string {
  return typeof type === "string"
    ? type
    : type.map((v) => JSON.stringify(v)).join(" | ");
}

/**
 * Validate a parsed object against a contract track; null when it conforms.
 *
 * Exported because the EXPERIMENTAL emit channel (`src/experimental-emit.ts`)
 * validates the SAME `OutputContract` on a different delivery. One contract, two
 * deliveries, one validator — a second copy would drift, and the two rails
 * disagreeing about what satisfies a contract is the worst outcome available.
 */
export function shapeError(
  obj: Record<string, unknown>,
  shape: Readonly<Record<string, OutputFieldType>>,
): string | null {
  for (const [field, type] of Object.entries(shape)) {
    if (!(field in obj)) return `missing field "${field}"`;
    if (!fieldMatches(obj[field], type)) {
      // `typeName`, not `type`: an enum interpolated raw renders as `CUT,MERGE,KEEP`,
      // which reads like a value rather than a choice among values.
      return `field "${field}" should be ${typeName(type)}`;
    }
  }
  return null;
}

/**
 * Parse the last `vigiles:ok` / `vigiles:err` block from a worker's output.
 *
 * With a `contract`, the parsed object is validated against the matching track's
 * shape — a worker that emits the wrong shape is `malformed`, not a silent pass.
 * Without one, any well-formed JSON block is accepted.
 */
export function parseAgentResult(
  text: string,
  contract?: OutputContract,
): ParsedAgentResult {
  BLOCK_RE.lastIndex = 0;
  let last: { track: "ok" | "err"; body: string } | null = null;
  for (let m = BLOCK_RE.exec(text); m !== null; m = BLOCK_RE.exec(text)) {
    last = { track: m[1] as "ok" | "err", body: m[2] };
  }
  if (!last) {
    return {
      kind: "malformed",
      reason: "no vigiles:ok/vigiles:err block found",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(last.body);
  } catch {
    return {
      kind: "malformed",
      reason: `invalid JSON in vigiles:${last.track} block`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      kind: "malformed",
      reason: `vigiles:${last.track} block must be a JSON object`,
    };
  }
  const obj = parsed as Record<string, unknown>;

  if (contract) {
    const shape = last.track === "ok" ? contract.ok : contract.err;
    const err = shapeError(obj, shape);
    if (err) {
      return { kind: "malformed", reason: `${last.track} block: ${err}` };
    }
  }

  return last.track === "ok"
    ? { kind: "ok", value: obj }
    : { kind: "err", error: obj };
}
