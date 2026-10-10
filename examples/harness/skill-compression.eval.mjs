/**
 * Worked example — verify a TOKEN-COMPRESSION claim with `runEval`.
 *
 * Tools like "Caveman Mode" make the agent answer in a telegraphic style to cut
 * output tokens (claims ~65–75%). That's a harness change with TWO questions, and
 * a headline % only answers the first:
 *
 *   1. Did it actually save tokens?         → measure `outputTokens` per arm
 *   2. Did it break the behaviour?          → measure the OUTCOME, gate regression
 *
 * vigiles is not a compression tool — it's the instrument that checks the claim
 * AND the blast radius. Two arms over the SAME task:
 *
 *   - arm `verbose` — answer normally (the baseline)
 *   - arm `caveman` — answer in telegraphic style: drop filler, keep every
 *                     technical fact (the compression under test)
 *
 * Metrics: `inputTokens` (the injection cost — a SKILL.md adds system-prompt
 * tokens every turn, so a "compression" win on output can be partially or fully
 * erased here), `outputTokens` (the thing being optimized — expect it lower on
 * `caveman`), and `correct` (the fact that must survive — expect it UNCHANGED).
 *
 * SkillBenchmark finding: measuring only `outputTokens` (or `tokens` total)
 * misleads. A skill injected into the system prompt raises `inputTokens` on every
 * turn, so the net cost delta is (inputDelta + outputDelta), not just outputDelta.
 * Measuring BOTH sides is what makes the trade-off honest.
 *
 * The point of the example is the triple pairing:
 *   - a token win on output that costs more on input is a partial or null win
 *   - a token win that silently drops the answer is not a win at all
 *   - this is how you'd catch either failure mode.
 *
 *   npx vigiles eval --trials=6 examples/harness/skill-compression.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth and a built dist/.
 * External users import from the package: `defineEval` + the free checks from
 * `"vigiles"`. An eval file declares its measurement; `vigiles eval` runs it.
 *
 * FINDING (2026-06-17, real haiku, 3 trials/arm, on the Pro/Max subscription —
 * apiKeySource:"none", $0.1057 total). The cost-metric capture works end-to-end:
 * `total_cost_usd`, input/output, AND cache tokens all populate from a real run.
 * The telling number — `inputTokens` read ~42/run (the UNCACHED remainder) while
 * each run's real volume was ~2.4–2.7k tok; the rest is cache reads. So measuring
 * `inputTokens` alone (or `tokens` = input+output) understates the real economics
 * by ~50× here — the cache classes are where the volume lives. Concrete vindication
 * of splitting the usage into input / output / cache (see `cacheTokens`). And the
 * compression claim did NOT hold on this task/model: the `caveman` arm's output was
 * +11% (762 → 842 tok/run) at +$0.002/run, correctness intact on both (Canberra) —
 * a headline "cuts tokens %" would have lied. Exactly the failure mode this catches.
 */
import { defineEval } from "../../dist/test.js";

const CAVEMAN = `# answer-style

Answer in TELEGRAPHIC style. Drop articles, filler, and pleasantries. Keep every
technical fact, name, and number exact. Short fragments over full sentences.
`;

// The task has a checkable fact (the capital) buried in a request that invites
// prose — so a too-aggressive compression that drops the fact is caught.
const TASK =
  "Read SKILL.md if it exists and follow its answer style. In one short reply, " +
  "name the capital city of Australia, then write it alone on the last line " +
  "prefixed with 'ANSWER: '. Write the whole reply to REPLY.txt. Then stop.";

export default defineEval({
  runEval: {
    name: "skill-compression: does telegraphic style cut tokens without dropping the fact?",
    env: { kind: "ephemeral" }, // a throwaway HOME and a scrubbed environment
    arms: {
      verbose: {},
      caveman: { files: { "SKILL.md": CAVEMAN } },
    },
    task: TASK,
    measure: (ctx) => {
      const reply = ctx.file("REPLY.txt") ?? "";
      const answer = /ANSWER:\s*([A-Za-z .]+)/i.exec(reply)?.[1]?.trim() ?? "";
      return {
        inputTokens: ctx.usage.inputTokens, // the injection cost: skill adds system-prompt tokens
        outputTokens: ctx.usage.outputTokens, // the optimization target
        correct: /canberra/i.test(answer) ? 1 : 0, // the fact that must survive
      };
    },
    trials: 3,
    model: "haiku",
  },
  assert: (report) => {
    // The three questions, answered from the arm means (`metrics` = mean per metric):
    const verbose = report.arms.verbose.metrics;
    const caveman = report.arms.caveman.metrics;

    // 1. Output side: did telegraphic style actually cut output tokens?
    const outputSaved =
      verbose.outputTokens > 0
        ? ((verbose.outputTokens - caveman.outputTokens) /
            verbose.outputTokens) *
          100
        : 0;
    console.log(
      `\ncaveman output-token delta vs verbose: ${outputSaved.toFixed(0)}% ` +
        `(${verbose.outputTokens.toFixed(0)} → ${caveman.outputTokens.toFixed(0)} tok/run)`,
    );

    // 2. Input side: did injecting the SKILL.md raise input tokens?
    // SkillBenchmark finding: a compression skill injects text into the system prompt
    // every turn, so the net cost delta is (inputDelta + outputDelta). Measure both —
    // a headline output saving is misleading if the injection cost erases it.
    const inputDelta = caveman.inputTokens - verbose.inputTokens;
    console.log(
      `caveman input-token delta vs verbose: ${inputDelta >= 0 ? "+" : ""}${inputDelta.toFixed(0)} tok/run ` +
        `(${verbose.inputTokens.toFixed(0)} → ${caveman.inputTokens.toFixed(0)})`,
    );

    // 3. The behavioural guardrail: a token saving that dropped the answer is not a win.
    if (caveman.correct < verbose.correct) {
      throw new Error(
        `caveman regressed correctness: ${caveman.correct} < ${verbose.correct} ` +
          `(verbose) — the token saving cost the answer, so it does not count`,
      );
    }
  },
});
