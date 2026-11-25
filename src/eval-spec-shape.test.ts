/**
 * The two exactly-one choices of an eval spec — `arms` or none, `checks` or
 * `measure` — refused at run time in the shapes the type forbids, because most
 * eval files are plain `.mjs` and nothing type-checks them. Every case runs
 * through `runEvalWith` with a runner that must never be reached: a refusal
 * that lands after the first trial has already spent.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { check, judged } from "./check.js";
import { runEvalWith, type AgentRunner, type EvalSpec } from "./eval.js";
import { DEFAULT_ARM, shapeEvalSpec } from "./eval-spec-shape.js";

const INHERIT = { kind: "inherit", reason: "unit test: never run" } as const;

const neverRuns: AgentRunner = () => {
  throw new Error("the runner must not be reached");
};

/** A spec as a plain-JS eval file can write it, whatever the type says. */
const loose = (spec: Readonly<Record<string, unknown>>): EvalSpec =>
  asSpec({ env: INHERIT, task: "t", ...spec });

const asSpec = (spec: unknown): EvalSpec =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the shapes under test are exactly the ones the type rules out
  spec as EvalSpec;

const refused = (spec: Readonly<Record<string, unknown>>, why: RegExp) =>
  assert.rejects(runEvalWith(loose(spec), neverRuns), why);

test("scoring is exactly one of `checks` and `measure`: both, and neither, are refused with the rewrite", async () => {
  await refused(
    { checks: [check.tool("Bash")], measure: () => ({}) },
    /runEval: score each trial with exactly ONE of `checks` or `measure` — this spec has both:\n {2}checks: \[check\.tool/,
  );
  await refused({}, /this spec has neither/);
});

test("a malformed scoring is refused by its field, not run", async () => {
  await refused(
    { measure: { ok: true } },
    /`measure` is a function of the run/,
  );
  await refused({ checks: [] }, /`checks` is a non-empty list/);
  await refused({ checks: check.tool("Bash") }, /`checks` is a non-empty list/);
  await refused(
    { checks: [check.tool("Bash"), "tool(Read)"] },
    /`checks\[1\]` is not a check/,
  );
});

test("the one-arm fields beside `arms` are refused: which arm would they configure?", async () => {
  await refused(
    { arms: { a: {} }, pluginDir: "/p", checks: [check.tool("Bash")] },
    /`pluginDir` configure the one arm of an eval with no `arms`\. This spec has `arms`: set it on each arm instead\./,
  );
  await refused(
    {
      arms: { a: {} },
      settings: {},
      interceptTools: [],
      checks: [check.tool("Bash")],
    },
    /`settings`, `interceptTools` configure .* set them on each arm instead/,
  );
  await refused(
    { arms: [{}], checks: [check.tool("Bash")] },
    /`arms` maps each arm's name to its configuration/,
  );
});

test("no `arms` is one arm named `default`, carrying exactly the top-level fields that were set", () => {
  const shape = shapeEvalSpec(
    loose({ pluginDir: "/p", checks: [check.tool("Bash")] }),
  );
  assert.equal(DEFAULT_ARM, "default");
  assert.deepEqual(shape.arms, { default: { pluginDir: "/p" } });
  assert.deepEqual(shape.checks, {
    "tool(Bash)": { kind: "tool", name: "Bash" },
  });
  // `measure` is passed through, and its report carries no `checks`.
  const measured = shapeEvalSpec(
    loose({ arms: { on: {} }, measure: () => ({ ok: true }) }),
  );
  assert.deepEqual(measured.arms, { on: {} });
  assert.equal(measured.checks, undefined);
});

test("a checks-scored trial is scored 0/1 per check, keyed by label", () => {
  const { measure } = shapeEvalSpec(
    loose({ checks: [check.output("done"), check.turns({ max: 0 })] }),
  );
  // The two fields these checks read; a run's full context is not needed.
  const ctx = { output: "all done", turns: 1, toolCalls: [] };
  assert.deepEqual(Reflect.apply(measure, undefined, [ctx]), {
    "output(done)": true,
    turns: false,
  });
});

test("stubSkillBodies with nothing to stub, or beside a judged check, is refused", async () => {
  await refused(
    { arms: { a: {}, b: {} }, stubSkillBodies: true, measure: () => ({}) },
    /`stubSkillBodies` requires `pluginDir` or `skillsDir` — on the spec, or on at least one arm/,
  );
  await refused(
    {
      pluginDir: "/p",
      stubSkillBodies: true,
      checks: [check.skill("x:y"), judged("is it good")],
    },
    /`stubSkillBodies` is for firing/,
  );
});
