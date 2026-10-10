/**
 * Type-level constraint: an eval file's `assert` gets the report its declared
 * measurement actually produces, and it cannot declare two measurements.
 *
 * Compiled with `tsc --noEmit` (npm run test:types); it asserts types, it is not
 * executed — which matters here more than usual, because EXECUTING an eval is
 * the thing that spends money. `// @ts-expect-error` marks must-NOT-compile
 * cases; a line that starts compiling turns the gate red.
 */
import { defineEval, experimental_stub } from "../../dist/test.js";
import type {
  ArmsCheckReport,
  CheckReport,
  EvalReport,
  TriggerRateReport,
} from "../../dist/test.js";
import type { SelectionReport } from "../../dist/claude-code.js";

// Each key picks the report type of its own runner — no cast at the call site.
defineEval({
  measureTriggerRate: { prompts: [], fired: () => true },
  assert: (r: TriggerRateReport) => void r.n,
});
defineEval({
  measure: { task: "t", checks: [] },
  assert: (r: CheckReport) => void r.perCheck,
});
defineEval({
  measureArms: { arms: {}, task: "t", checks: [] },
  assert: (r: ArmsCheckReport) => void r.arms,
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

// Where a trial runs is a choice with no default: no `env`, no spec.
defineEval({
  // @ts-expect-error `runEval` needs an `env`
  runEval: { arms: {}, task: "t", measure: () => ({ ok: 1 }) },
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
  measure: { task: "t", checks: [] },
  // @ts-expect-error a CheckReport has no `arms`
  assert: (r: ArmsCheckReport) => void r.arms,
});

// Exactly one measurement: two keys is a file whose author expected both to run.
// @ts-expect-error `measure` and `runEval` cannot both be declared
defineEval({
  measure: { task: "t", checks: [] },
  runEval: { arms: {}, task: "t", measure: () => ({ ok: 1 }) },
});

// A spec still has to be a real spec for its runner.
defineEval({
  // @ts-expect-error `measure` needs a `task`
  measure: { checks: [] },
});

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
