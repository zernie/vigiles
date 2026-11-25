/**
 * Type-level constraint: an eval file's `assert` gets the report its declared
 * measurement actually produces, it cannot declare two measurements, and a
 * `runEval` spec takes exactly one of `arms`-or-not and `checks`-or-`measure`.
 *
 * Compiled with `tsc --noEmit` (npm run test:types); it asserts types, it is not
 * executed — which matters here more than usual, because EXECUTING an eval is
 * the thing that spends money. `// @ts-expect-error` marks must-NOT-compile
 * cases; a line that starts compiling turns the gate red.
 */
import { defineEval, check } from "../../dist/entries/index.js";
import { experimental_stub } from "../../dist/entries/fixtures.js";
import {
  assertImproves,
  assertRates,
  compare,
} from "../../dist/entries/eval.js";
import type {
  EvalReport,
  EvalSpec,
  TriggerRateReport,
} from "../../dist/entries/index.js";
import type { SelectionReport } from "../../dist/entries/harness/claude-code.js";

const env = { kind: "inherit", reason: "a type test: never run" } as const;

// Each key picks the report type of its own runner — no cast at the call site.
defineEval({
  measureTriggerRate: { prompts: [], fired: () => true },
  assert: (r: TriggerRateReport) => void r.n,
});
defineEval({
  runEval: {
    env: { kind: "ephemeral" },
    arms: {},
    task: "t",
    measure: () => ({ ok: 1 }),
  },
  assert: (r: EvalReport) => void r.totalCostUsd,
});
// One configuration scored by checks — the former single-config runner — is a `runEval`
// whose report is the same `EvalReport`, with the checks it was scored by.
defineEval({
  runEval: { env, pluginDir: ".", task: "t", checks: [check.tool("Bash")] },
  assert: (r: EvalReport) => void r.checks,
});
// Several configurations scored by checks — the former checks A/B runner.
defineEval({
  runEval: {
    env,
    arms: { off: {}, on: { pluginDir: "." } },
    task: "t",
    checks: [check.skill("p:s")],
  },
  assert: (r: EvalReport) => void r.arms.on?.namespace,
});

// Scoring is exactly one of `checks` and `measure`.
const both: EvalSpec = {
  env,
  task: "t",
  // @ts-expect-error `checks` and `measure` cannot both score a trial
  checks: [check.tool("Bash")],
  measure: () => ({ ok: 1 }),
};
// @ts-expect-error a spec with neither `checks` nor `measure` scores nothing
const neither: EvalSpec = { env, task: "t" };
// The one-arm fields belong to a spec with no `arms`.
const armsAndTop: EvalSpec = {
  env,
  arms: { a: {} },
  // @ts-expect-error `pluginDir` beside `arms`: set it on each arm instead
  pluginDir: ".",
  task: "t",
  checks: [check.tool("Bash")],
};
void [both, neither, armsAndTop];

// Where a trial runs is a choice with no default: no `env`, no spec.
defineEval({
  // @ts-expect-error `runEval` needs an `env`
  runEval: { arms: {}, task: "t", measure: () => ({ ok: 1 }) },
});
defineEval({
  // @ts-expect-error a former `measure` spec needs an `env` too
  runEval: { task: "t", checks: [check.tool("Bash")] },
});
// `home` exists only on an ephemeral env — "seed my real HOME" cannot be written.
defineEval({
  runEval: {
    // @ts-expect-error no `home` on an inherited env
    env: { kind: "inherit", reason: "r", home: { kind: "files", files: {} } },
    arms: {},
    task: "t",
    measure: () => ({ ok: 1 }),
  },
});
defineEval({
  measureSelectionMatrix: { pluginDir: "." },
  assert: (r: SelectionReport) => void r.collisionRate,
});

// The report is the DECLARED measurement's, not any other's.
defineEval({
  measureTriggerRate: { prompts: [], fired: () => true },
  // @ts-expect-error a TriggerRateReport is not an EvalReport
  assert: (r: EvalReport) => void r.arms,
});

// Exactly one measurement: two keys is a file whose author expected both to run.
// @ts-expect-error `measureTriggerRate` and `runEval` cannot both be declared
defineEval({
  measureTriggerRate: { prompts: [], fired: () => true },
  runEval: { env, arms: {}, task: "t", measure: () => ({ ok: 1 }) },
});

// The keys folded into `runEval` in v55 are gone.
defineEval({
  // @ts-expect-error `measure` is no longer a measurement — declare `runEval`
  measure: { task: "t", checks: [] },
});

// A spec still has to be a real spec for its runner.
defineEval({
  // @ts-expect-error `runEval` needs a `task`
  runEval: { env, checks: [check.tool("Bash")] },
});

// The readers: one report shape, a direction for a lower-is-better metric.
declare const report: EvalReport;
assertRates(report, { min: 0.8 }); // every check of the only arm
assertRates(report, { arm: "on", min: 0.8, per: { skill: 1 } });
assertRates(report, { arm: "on", metric: "tool(Bash)", passK: 1 });
// @ts-expect-error `per` is by check kind — it means nothing beside one `metric`
assertRates(report, { metric: "tool(Bash)", min: 0.8, per: { skill: 1 } });
// @ts-expect-error a gate with no threshold passes anything
assertRates(report, { arm: "on" });
assertImproves(report, {
  baseline: "off",
  arm: "on",
  metric: "cost",
  lowerIsBetter: true,
});
assertImproves(report, {
  baseline: "off",
  arm: "on",
  metric: "cost",
  // @ts-expect-error one metric, one direction: the list form is `compare`'s
  lowerIsBetter: ["cost"],
});
void compare(report, "off", "on", { lowerIsBetter: ["cost", "turns"] });

// A stub rule's `rest` can only close the pattern, and a stub has at least one rule.
const { rest } = experimental_stub;
experimental_stub("gh", [
  { argv: ["issue", "create", rest], reply: { kind: "always", stdout: "u" } },
]);
experimental_stub("gh", [
  // @ts-expect-error `rest` before another token
  { argv: [rest, "x"], reply: { kind: "always" } },
]);
// @ts-expect-error a stub with no rules
experimental_stub("gh", []);
