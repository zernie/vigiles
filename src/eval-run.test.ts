/**
 * The exit codes `src/eval-run.ts` answers with. The run itself is exercised
 * through child processes in `entries/eval.test.ts` and `eval-entry.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  UNANSWERED_STUB_EXIT_CODE,
  UNANSWERED_STUB_VERB_EXIT,
} from "./eval-entry.js";
import { exitCodeOf, publicExitCodeOf, type EvalOutcome } from "./eval-run.js";

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
