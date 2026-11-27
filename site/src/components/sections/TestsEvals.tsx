import { CodeBlock } from "@/components/CodeBlock";
import { Term } from "@/components/Term";
import hookTestSnippet from "@/snippets/hook-test.ts?raw";
import lock from "./__fixtures__/tdd-trigger-rate.json";

const DOCS = "https://github.com/zernie/vigiles/blob/main/docs";

// The failure line is the message `check.hook(..., { blocked: true })` builds in
// src/check.ts (`firedAlone`); `assertChecks` prefixes "  ✗ ", and the summary
// ("0 passed, 1 failed.") is `formatScriptSummary` in
// src/adapters/claude-code/run-scripts.ts.
const TEST_OUTPUT = `  ✗ expected the hook to block PreToolUse, but it allowed (exit 0)
0 passed, 1 failed.`;

// Real API: `defineEval({ measureTriggerRate })` — see
// examples/harness/skill-trigger-rate.eval.mjs (pluginDir, stubSkillBodies,
// prompts, fired, trials).
const EVAL_SNIPPET = `import { defineEval, check } from "vigiles";

// Asked for test-first work, does
// the model pick the TDD skill?
export default defineEval({
  measureTriggerRate: {
    pluginDir: "./plugins/superpowers",
    // Skill bodies become stubs: this
    // scores the CHOICE, not the work.
    stubSkillBodies: true,
    // Ten phrasings of one request.
    prompts: [
      "Implement a stack class in stack.js. Use TDD.",
      "Fix the off-by-one in paginate(); add a regression test first.",
      // ...8 more
    ],
    // A hit: this skill was invoked.
    fired: check.skill("superpowers:test-driven-development"),
    // 10 prompts × 3 = 30 runs. The
    // report lists each missed prompt.
    trials: 3,
  },
});`;

type Usage = typeof lock.report.usage;

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtK = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

/**
 * The eval output block, derived from the committed fixture (the lock written
 * by `vigiles eval --update`). Mirrors `formatTriggerRateReport`
 * (src/eval-format.ts) and `formatCostSummary` (src/eval-cost.ts); only the
 * misses are listed — the prompts that always fire would just be noise.
 */
export function evalOutput(report: typeof lock.report): string {
  const pct = (report.rate * 100).toFixed(0);
  const u: Usage = report.usage;
  const tokens =
    u.totalInputTokens +
    u.totalOutputTokens +
    u.totalCacheCreationTokens +
    u.totalCacheReadTokens;
  const misses = report.perPrompt
    .filter((p) => p.rate < 1)
    .sort((a, b) => a.rate - b.rate)
    .map((p) => `  ${p.rate.toFixed(2)}  ${p.prompt.slice(0, 60)}`);
  return [
    `trigger-rate: ${pct}% (${String(report.n)} runs)`,
    ...misses,
    report.competitors > 0
      ? `whole-harness: measured against ${String(report.competitors)} competing skill(s)`
      : "isolated: no competing skills",
    `  Spent: ${fmtInt(tokens)} tokens (${fmtK(u.totalInputTokens)} in · ${fmtK(u.totalOutputTokens)} out · ${fmtK(u.totalCacheReadTokens)} cache) · ~$${u.totalCostUsd.toFixed(2)} API-equivalent`,
    "  Billed to: your Claude subscription — $0 metered ✅",
  ].join("\n");
}

const EVAL_OUTPUT = evalOutput(lock.report);

function DocLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-block text-[15px] font-medium text-accent no-underline hover:underline"
    >
      {children}
    </a>
  );
}

export function TestsEvals() {
  const testCmd = "npx vigiles test hook.test.mjs";
  const evalCmd = "npx vigiles eval tdd.eval.mjs";
  return (
    <section
      id="tests"
      className="band band-tint mx-auto w-full max-w-[1180px] px-6"
    >
      <h2 className="section-title mb-4">Test your setup like code.</h2>
      <p className="mb-9 max-w-[560px] text-[19px] text-muted-foreground">
        Write a test for a hook or a skill once. Run it on every change.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-[1000px]:gap-16">
        <div className="min-w-0">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
            Tests
          </h3>
          <p className="mb-5 mt-1.5 text-muted-foreground">
            Deterministic. No model, no key. Runs in CI.
          </p>
          <Term copyText={hookTestSnippet}>
            <CodeBlock
              code={hookTestSnippet.trim()}
              language="typescript"
              className="rounded-none border-0 bg-transparent! p-0! text-[12px]"
            />
            <pre className="mt-5">
              <span className="t-mut">$</span> {testCmd}
            </pre>
            <pre className="mt-1">{TEST_OUTPUT}</pre>
          </Term>
          <DocLink href={`${DOCS}/harness-testing.md`}>
            How testing works ›
          </DocLink>
        </div>
        <div className="min-w-0">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
            Evals
          </h3>
          <p className="mb-5 mt-1.5 text-muted-foreground">
            A real model on your Claude subscription. Prints the token bill.
          </p>
          <Term copyText={EVAL_SNIPPET}>
            <CodeBlock
              code={EVAL_SNIPPET}
              language="typescript"
              className="rounded-none border-0 bg-transparent! p-0! text-[12px]"
            />
            <pre className="mt-5">
              <span className="t-mut">$</span> {evalCmd}
            </pre>
            <pre className="mt-1">{EVAL_OUTPUT}</pre>
          </Term>
          <DocLink href={`${DOCS}/measuring-skills.md`}>
            How evals work ›
          </DocLink>
        </div>
      </div>
    </section>
  );
}
