/**
 * Worked example: assert a subagent's TYPED OUTCOME deterministically — the
 * railway / Result payoff.
 *
 * A subagent with a `result()` contract is told (in its compiled system prompt)
 * to end its turn with exactly one fenced block — `vigiles:ok` on the success
 * track, `vigiles:err` on the error track:
 *
 *   ```vigiles:ok
 *   { "files": ["src/parser.ts"], "summary": "added the parser, tests green" }
 *   ```
 *
 * `assertAgentOk` / `assertAgentErr` / `assertAgentResult` parse that block and
 * validate it against the contract. The point: this is a DETERMINISTIC assert
 * that REPLACES an LLM judge. Instead of paying a model to grade
 *   judged(output, "did the worker succeed and change a test file?")
 * — non-deterministic, costs tokens — you assert the structured outcome:
 *   assertAgentResult(output, r => r.kind === "ok" && r.value.files.some(isTest))
 * — model-free, free, exact. The typed outcome is the contract; the assert reads it.
 *
 * Part A runs anywhere (pure text → Result, no `claude`). Part B runs the SAME
 * assert over a real harness turn driven by a scripted mock model (needs the
 * `claude` binary, but NO API key — the mock stands in for the model).
 *
 *   npx vigiles test examples/harness/railway-result.harness.mjs
 */
import assert from "node:assert/strict";
import {
  experimental_agent,
  assertAgentOk,
  assertAgentErr,
  assertAgentResult,
} from "../../dist/entries/spec.js";
const { result } = experimental_agent;
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";

// The implementer worker's contract (mirrors examples/railway/ship-pr.md.spec.ts):
// success carries the files it changed + a summary; the error track carries a
// machine-readable reason + which step failed.
const implementer = result(
  { files: "string[]", summary: "string" },
  { reason: "string", step: "string" },
);

// --- Part A: the deterministic assert (always runs, no claude) --------------
// In a real run these strings are the subagent's final message; asserting the
// path directly shows it's a pure, model-free text → Result parse.

const okOutput = [
  "Implemented the parser and ran the suite.",
  "```vigiles:ok",
  '{ "files": ["src/parser.ts", "src/parser.test.ts"], "summary": "added the parser, tests green" }',
  "```",
].join("\n");

const value = assertAgentOk(okOutput, implementer);
assert.deepEqual(value.files, ["src/parser.ts", "src/parser.test.ts"]);
console.log("✓ ok track: assertAgentOk validated the success shape + fields");

const errOutput = [
  "Could not finish — the build broke.",
  "```vigiles:err",
  '{ "reason": "tsc failed: 3 errors", "step": "implementer" }',
  "```",
].join("\n");

const error = assertAgentErr(errOutput, implementer);
assert.equal(error.step, "implementer");
console.log("✓ err track: assertAgentErr validated the failure shape");

// assertAgentResult is the general predicate form — assert RICH detail
// ("succeeded AND touched a test file"), still deterministic, still no judge.
assertAgentResult(
  okOutput,
  (r) => r.kind === "ok" && r.value.files.some((f) => f.endsWith(".test.ts")),
  implementer,
);
console.log("✓ predicate: succeeded AND changed a test file (no LLM judge)");

// A worker that ignores its contract is `malformed` — the honest third track,
// caught, not silently passed (prose instead of a result block).
assertAgentResult("I think it worked!", (r) => r.kind === "malformed");
console.log("✓ malformed: prose-only output is caught, not passed");

// --- Part B: the same assert over a real (mock-driven) harness turn ---------
if (!claudeAvailable()) {
  console.log("ℹ harness-scope check needs the `claude` CLI — skipping it");
} else {
  const r = await runHarnessTest({
    transcript: true,
    prompt: "implement the thing, then end your turn with your result block",
    model: scriptModel([
      {
        text: [
          "Done — shipped the change.",
          "```vigiles:ok",
          '{ "files": ["a.ts"], "summary": "shipped" }',
          "```",
        ].join("\n"),
      },
    ]),
  });
  try {
    const v = assertAgentOk(r.output, implementer);
    assert.equal(v.summary, "shipped");
    console.log(
      "✓ harness run: assertAgentOk over the agent's real output text",
    );
  } finally {
    r.cleanup();
  }
}
