/**
 * Tests for the railway-oriented subagent surface: the result() contract on an
 * agent (compiled into a vigiles:ok/err output section) and railway()/delegate()
 * composition over flat workers (compiled to an orchestrator command, with
 * compile-time verification of delegate targets + bounded recovery). Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { experimental_agent } from "./spec.js";
const { result, railway, delegate } = experimental_agent;
import { compileAgent, compileRailway, validateRailway } from "./compile.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";

// --- result() contract on an agent -----------------------------------------

test("compileAgent renders the result contract as an Output contract section", async () => {
  const { markdown, errors } = await compileAgent(
    experimental_agent({
      name: "coder",
      description: "Write code.",
      tools: ["Read", "Edit", "Bash"],
      body: "You write code.",
      output: result(
        { files: "string[]", summary: "string" },
        { reason: "string", retryable: "boolean" },
      ),
    }),
    { specFile: "agents/coder.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  assert.match(markdown, /## Output contract/);
  assert.match(markdown, /```vigiles:ok/);
  assert.match(markdown, /"files": string\[\], "summary": string/);
  assert.match(markdown, /```vigiles:err/);
  assert.match(markdown, /"reason": string, "retryable": boolean/);
});

test("an agent without a result contract has no Output contract section", async () => {
  const { markdown } = await compileAgent(
    experimental_agent({ name: "a", description: "d", body: "b" }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.doesNotMatch(markdown, /## Output contract/);
});

test("an empty contract track renders as {}", async () => {
  const { markdown } = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      body: "b",
      output: result({}, { reason: "string" }),
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.match(markdown, /```vigiles:ok\n\{\}\n```/);
});

// --- delegate() / railway() builders ---------------------------------------

test("delegate() carries an optional task hint", () => {
  assert.deepEqual(delegate("planner"), {
    _step: "delegate",
    agent: "planner",
  });
  assert.deepEqual(delegate("coder", "write it"), {
    _step: "delegate",
    agent: "coder",
    task: "write it",
  });
});

test("railway() sets the spec type and fields", () => {
  const rw = railway({
    name: "ship",
    steps: [delegate("planner"), delegate("coder")],
    onError: delegate("reporter"),
    recover: { step: delegate("fixer"), max: 2 },
  });
  assert.equal(rw._specType, "railway");
  assert.equal(rw.steps.length, 2);
});

// --- compileRailway --------------------------------------------------------

test("compileRailway renders an orchestrator command with hash + tracks", () => {
  const { markdown, errors } = compileRailway(
    railway({
      name: "ship",
      steps: [delegate("planner", "draft a plan"), delegate("coder")],
      onError: delegate("reporter"),
      recover: { step: delegate("fixer"), max: 2 },
    }),
    { knownAgents: ["planner", "coder", "reporter", "fixer"] },
  );
  assert.deepEqual(errors, []);
  assert.match(markdown, /^<!-- vigiles:sha256:[a-f0-9]+ compiled from/);
  assert.match(markdown, /# Railway: ship/);
  assert.match(markdown, /## Success track/);
  assert.match(markdown, /1\. \*\*planner\*\* — draft a plan/);
  assert.match(markdown, /2\. \*\*coder\*\*/);
  assert.match(markdown, /## Recovery[\s\S]*\*\*fixer\*\* up to 2×/);
  assert.match(markdown, /## On error[\s\S]*\*\*reporter\*\*/);
});

test("compileRailway omits Recovery / On error when not declared", () => {
  const { markdown } = compileRailway(
    railway({ name: "min", steps: [delegate("solo")] }),
    { knownAgents: ["solo"] },
  );
  assert.doesNotMatch(markdown, /## Recovery/);
  assert.doesNotMatch(markdown, /## On error/);
});

// --- validateRailway (the static, sub-Turing guarantees) -------------------

test("flags a delegate to an unknown agent (stale-ref)", () => {
  const errs = validateRailway(
    railway({ name: "ship", steps: [delegate("planr")] }), // typo
    ["planner", "coder"],
  );
  assert.equal(errs.length, 1);
  assert.equal(errs[0].type, "stale-ref");
  assert.match(errs[0].message, /unknown agent "planr"/);
});

test("checks the onError and recover targets too", () => {
  const errs = validateRailway(
    railway({
      name: "ship",
      steps: [delegate("planner")],
      onError: delegate("ghost"),
      recover: { step: delegate("phantom"), max: 1 },
    }),
    ["planner"],
  );
  assert.equal(errs.length, 2);
  assert.ok(errs.every((e) => e.type === "stale-ref"));
});

test("flags an empty railway", () => {
  const errs = validateRailway(railway({ name: "empty", steps: [] }));
  assert.ok(
    errs.some(
      (e) => e.type === "invalid-railway" && /no steps/.test(e.message),
    ),
  );
});

test("flags unbounded/zero recovery (must be ≥ 1 — the finite guarantee)", () => {
  const errs = validateRailway(
    railway({
      name: "ship",
      steps: [delegate("planner")],
      recover: { step: delegate("fixer"), max: 0 },
    }),
    ["planner", "fixer"],
  );
  assert.ok(
    errs.some(
      (e) => e.type === "invalid-railway" && /max must be ≥ 1/.test(e.message),
    ),
  );
});

test("skips agent resolution when knownAgents is omitted", () => {
  // no registry → don't flag delegate targets (mirrors linter verify modes)
  const errs = validateRailway(
    railway({ name: "ship", steps: [delegate("anything")] }),
  );
  assert.deepEqual(errs, []);
});

test("compileRailway defaults the spec filename from the railway name", () => {
  const { markdown } = compileRailway(
    railway({ name: "ship", steps: [delegate("a")] }),
  );
  assert.match(markdown, /compiled from ship\.railway\.spec\.ts/);
});
