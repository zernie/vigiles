import { CopyPill } from "@/components/Term";
import lock from "./__fixtures__/tdd-trigger-rate.json";

const AGENT_PROMPT =
  "Set up vigiles in this repo: run `npx vigiles init` and accept the defaults.";

// Cost line format: formatCostSummary in src/eval-cost.ts. The numbers are from
// the committed trigger-rate lock (see TestsEvals.tsx), not typed here.
const u = lock.report.usage;
const TOKENS =
  u.totalInputTokens +
  u.totalOutputTokens +
  u.totalCacheCreationTokens +
  u.totalCacheReadTokens;

function Box({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid items-start gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <span className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground sm:pt-3">
        {label}
      </span>
      <div className="relative rounded-[10px] bg-[#1b1a17] py-3 pl-4 pr-24 font-mono text-sm leading-[1.55] text-[#e9e4d8] [overflow-wrap:anywhere] whitespace-pre-wrap">
        {text}
        <CopyPill text={text} className="absolute right-2.5 top-[9px]" />
      </div>
    </div>
  );
}

const code = "font-mono text-[13px]";

export function Start() {
  return (
    <section id="start" className="band mx-auto w-full max-w-[1180px] px-6">
      <div className="max-w-[760px]">
        <h2 className="section-title">
          One command. Then let your agent do the rest.
        </h2>
        <div className="grid gap-3.5">
          <Box label="Grade it" text="npx vigiles audit" />
          <Box label="Or ask your agent" text={AGENT_PROMPT} />
        </div>
        <CoverageLine />
        <div className="mt-9 text-[15px]">
          <details className="mb-2.5">
            <summary className="font-semibold">
              Does anything leave my machine?
            </summary>
            <p className="mt-2">
              <code className={code}>audit</code> and{" "}
              <code className={code}>lint</code> read files on disk; nothing is
              uploaded. The in-browser grader fetches only a public repo you
              name, from GitHub&apos;s API, in your browser. A model is called
              only by <code className={code}>eval</code>, or by{" "}
              <code className={code}>audit</code> if you say yes when it asks.
            </p>
          </details>
          <details className="mb-2.5">
            <summary className="font-semibold">What do evals cost?</summary>
            <p className="mt-2">
              They run on your own Claude subscription, through your{" "}
              <code className={code}>claude</code> CLI. Each run prints the
              bill:{" "}
              <code className={code}>
                Spent: {TOKENS.toLocaleString("en-US")} tokens … ~$
                {u.totalCostUsd.toFixed(2)} API-equivalent
              </code>
              ,{" "}
              <code className={code}>
                Billed to: your Claude subscription — $0 metered
              </code>
              . (Those numbers are a real 30-run trigger-rate measurement.)
            </p>
          </details>
          <details className="mb-2.5">
            <summary className="font-semibold">
              Do I have to rewrite my CLAUDE.md?
            </summary>
            <p className="mt-2">
              No. Your markdown stays the source of truth.{" "}
              <code className={code}>audit</code> and{" "}
              <code className={code}>lint</code> read the CLAUDE.md or AGENTS.md
              you already have, as-is.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}

/** The harnesses vigiles covers, one line under the install command. */
export function CoverageLine() {
  return (
    <p className="mt-4 text-sm text-muted-foreground">
      Works with Claude Code and Codex.
    </p>
  );
}
