/**
 * The exit codes `src/eval-run.ts` answers with, and what its preflight
 * refuses before `skipIf`. The run itself is exercised through child
 * processes in `entries/eval.test.ts` and `eval-entry.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  UNANSWERED_STUB_EXIT_CODE,
  UNANSWERED_STUB_VERB_EXIT,
} from "./eval-entry.js";
import { EVAL_DEFINITION } from "./eval-define.js";
import {
  exitCodeOf,
  publicExitCodeOf,
  runDefinition,
  type EvalOutcome,
} from "./eval-run.js";

const failedWith = (code: number): EvalOutcome => ({
  kind: "failed",
  code,
  message: "m",
  report: undefined,
});

test("publicExitCodeOf gives the code `vigiles eval` exits with, not the child's sentinel", () => {
  // Guards: Codex finding on #587 — `paid_runEval` exited 78 on an unanswered
  // stub where `vigiles eval` exits 2 for the same eval.
  assert.equal(
    exitCodeOf(failedWith(UNANSWERED_STUB_EXIT_CODE)),
    UNANSWERED_STUB_EXIT_CODE,
  );
  assert.equal(
    publicExitCodeOf(failedWith(UNANSWERED_STUB_EXIT_CODE)),
    UNANSWERED_STUB_VERB_EXIT,
  );
  // The quiet half: every other code passes through unchanged.
  assert.equal(publicExitCodeOf(failedWith(1)), 1);
  assert.equal(publicExitCodeOf({ kind: "refused", message: "m" }), 1);
  assert.equal(publicExitCodeOf({ kind: "skipped", reason: "r" }), 77);
});

test("a malformed case list is refused before skipIf runs", async () => {
  const skips: string[] = [];
  const definition = {
    [EVAL_DEFINITION]: true,
    runEval: {
      env: { kind: "inherit", reason: "unit test" },
      experimental_regressionCases: [{ id: "no-repo" }],
    },
    skipIf: () => {
      skips.push("asked");
      return "no agent binary here";
    },
  };
  const outcome = await runDefinition(definition, {
    label: "cases.eval.mjs",
    trials: undefined,
    host: undefined,
  });
  // Guards: a file that skips on this machine still shows its broken case list.
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(skips, []);
});
