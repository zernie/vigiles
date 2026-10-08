/**
 * Deterministic harness test (`runHarnessTest`): the two agent-loop behaviours a
 * hook author builds on, against the real `claude` CLI and the scripted mock model.
 *
 *   1. The tool loop closes — a scripted tool call runs, its result goes back to
 *      the model, and the next scripted turn is the final answer.
 *   2. A Stop-hook result gate holds completion — a skill marked active has its
 *      `vigiles:result` gate run by `vigiles hook-runtime skill` when the agent tries
 *      to stop; exit 2 sends the reason back and the agent keeps working until
 *      the gate passes.
 *
 *   npx vigiles test examples/harness/agent-loop.harness.mjs
 *
 * Needs the `claude` CLI and a built dist/ (`npm run build`).
 */
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { skip } from "../../dist/harness-assert.js";

if (!claudeAvailable()) skip("`claude` CLI not found");

const CLI = new URL("../../dist/cli.js", import.meta.url).pathname;

/** Sequential runner: ✓/✗ per case, non-zero exit on any failure. */
async function run(cases) {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  console.log(
    failed === 0 ? `\n${cases.length} passed.` : `\n${failed} failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** A project where `skills/demo` is active and its result gate is `gate`. */
const gatedProject = (gate) => ({
  files: {
    "skills/demo/SKILL.md": `## Result\n<!-- vigiles:result "${gate}" -->\n`,
    ".vigiles/active-skill.json": '{"skill":"skills/demo/SKILL.md"}\n',
  },
  settings: {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: `node ${CLI} hook-runtime skill` },
          ],
        },
      ],
    },
  },
});

await run([
  [
    "tool loop: the tool runs, its result reaches the model, the next turn is the final answer",
    async () => {
      const r = await runHarnessTest({
        transcript: true,
        prompt: "run the bash tool",
        allowedTools: ["Bash"],
        model: scriptModel([
          { tool: "Bash", input: { command: "echo TOOLRAN | tee RAN" } },
          { text: "E2E_TOOL_OK_beta" },
        ]),
      });
      try {
        assert(
          (r.file("RAN") ?? "").includes("TOOLRAN"),
          "the tool did not run",
        );
        assert(
          /E2E_TOOL_OK_beta/.test(r.output),
          `the final answer did not come back (got: ${r.output})`,
        );
        const afterTool = r.modelRequests.filter(
          (req) =>
            !req.sideChannel &&
            req.messages.some((m) => m.text.includes("TOOLRAN")),
        );
        assert(
          afterTool.length === 1,
          "the tool result was not sent back to the model",
        );
        assert(r.turns === 2, `expected 2 agent turns, got ${r.turns}`);
      } finally {
        r.cleanup();
      }
    },
  ],
  [
    "Stop-hook result gate: a passing gate lets the agent stop on its first turn",
    async () => {
      const r = await runHarnessTest({
        ...gatedProject("true"),
        model: scriptModel([{ text: "done" }]),
      });
      try {
        assert(
          r.turns === 1,
          `a passing gate should not block (turns=${r.turns})`,
        );
      } finally {
        r.cleanup();
      }
    },
  ],
  [
    "Stop-hook result gate: a failing gate blocks completion until it passes",
    async () => {
      const r = await runHarnessTest({
        ...gatedProject("test -f GATE_OPEN"),
        model: scriptModel([
          { text: "done" }, // gate closed: Stop is blocked, the reason goes back
          { tool: "Bash", input: { command: "touch GATE_OPEN" } },
          { text: "done" }, // gate open: allowed
        ]),
      });
      try {
        assert(
          r.file("GATE_OPEN") !== null,
          "the agent was never sent back to work",
        );
        assert(
          r.turns === 3,
          `expected 3 agent turns (blocked once), got ${r.turns}`,
        );
      } finally {
        r.cleanup();
      }
    },
  ],
]);
