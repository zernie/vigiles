/**
 * Side-effect boundary — assert a unit stayed inside its declared write surface
 * DETERMINISTICALLY (no model judge, no API key). Rung 2 of the testability
 * ladder (research/typed-contracts-for-agents.md): a skill that declares it
 * writes only `out.txt` and never pushes is *asserted*, not eyeballed.
 *
 * The check vocabulary is the seam:
 *   - check.writes({ include }) — it produced the artifact it promised
 *   - check.writes({ none })    — it left nothing OUTSIDE the boundary
 *   - check.tool(name, { with, max: 0 }) — it never reached for a forbidden
 *     side effect (git push)
 *
 * Part A is pure (a hand-built Trace) and ALWAYS runs. Part B drives a real
 * scripted mock turn through `runHarnessTest` — needs the `claude` BINARY but NO
 * key, so it RUNS here and in CI.
 *
 *   npx vigiles test examples/harness/effect-boundary.harness.mjs
 */
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { check, assertChecks } from "../../dist/check.js";

// --- Part A: pure — the boundary asserted over a constructed Trace -----------
// Model a unit that wrote `out.txt` and called Bash `git status` (read-only),
// but never `git push` and never touched `secrets.env`.
const inBounds = {
  output: "done",
  turns: 1,
  hooks: [],
  toolCalls: [
    { name: "Write", input: { file_path: "out.txt", content: "result" } },
    { name: "Bash", input: { command: "git status" } },
  ],
  file: (p) => (p === "out.txt" ? "result" : null),
};

// The declared side-effect boundary, asserted deterministically:
assertChecks(inBounds, [
  check.writes({ include: ["out.txt"] }), // produced what it promised
  check.writes({ none: ["secrets.env"] }), // wrote nothing outside the surface
  check.tool("Bash", { with: { command: /git push/ }, max: 0 }), // never pushed
]);
console.log("✓ Part A: unit stayed inside its declared write surface");

// And the boundary CATCHES an escape — a unit that pushed + wrote a stray file:
const escaped = {
  output: "oops",
  turns: 1,
  hooks: [],
  toolCalls: [{ name: "Bash", input: { command: "git push origin main" } }],
  file: (p) => (p === "secrets.env" ? "leaked" : null),
};
let caught = false;
try {
  assertChecks(escaped, [
    check.writes({ none: ["secrets.env"] }),
    check.tool("Bash", { with: { command: /git push/ }, max: 0 }),
  ]);
} catch {
  caught = true;
}
if (!caught) throw new Error("boundary failed to catch the escape");
console.log("✓ Part A: boundary catches a write/push escape");

// --- Part B: the SAME checks over a real mock-driven run ---------------------
if (!claudeAvailable()) {
  console.log("ℹ Part B needs the `claude` CLI — skipping the live mock run");
} else {
  // Default prompt only: a custom prompt makes the scripted turn a no-op, so the
  // Write never runs (see harness-test.test.ts). Script a single Write.
  const r = await runHarnessTest({
    transcript: true,
    model: scriptModel([
      { tool: "Write", input: { file_path: "out.txt", content: "result" } },
      { text: "done" },
    ]),
  });
  try {
    // check.writes reads the real post-run work dir: `include` the promised
    // artifact, `none` proves the unit never created the off-boundary file —
    // both deterministic, no model judge.
    assertChecks(r, [
      check.writes({ include: ["out.txt"], none: ["secrets.env"] }),
    ]);
    console.log("✓ Part B: real run wrote out.txt and nothing outside it");
  } finally {
    r.cleanup();
  }
}
