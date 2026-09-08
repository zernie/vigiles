import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const AGENT_PROMPT = `Set up vigiles in this repo: run \`npx vigiles init\` and accept the defaults.
If I already have a CLAUDE.md or AGENTS.md, audit it and show me which references
are stale and which of my rules aren't enforced. Then write + run one harness test
for a hook or skill of mine. Don't run a real-model eval without asking me first.`;

/** The ask → what the agent does. Each is a shipped model-invocable skill. */
const SKILLS: { ask: string; does: string; skill: string }[] = [
  {
    ask: "test my skills",
    does: "scaffolds and runs a trigger/behaviour test, then commits its result so CI checks it",
    skill: "test-harness",
  },
  {
    ask: "harden my rules",
    does: "upgrades prose guidance into enforced linter rules",
    skill: "strengthen",
  },
  {
    ask: "add a rule to my CLAUDE.md or AGENTS.md",
    does: "edits it safely and keeps every reference verified",
    skill: "edit-spec",
  },
  {
    // The fourth shipped model-invocable skill. It was missing from this list
    // while the repo's own great-agent-flow rule names four — so the page
    // undersold the thing it exists to sell.
    ask: "why didn't my hook block?",
    does: "reads the local run log and names which hook decided what, and which skill fired",
    skill: "debug-my-harness",
  },
];

export function Adoption() {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(AGENT_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <section
      id="adopt"
      className="scroll-mt-8 border-t border-border bg-card/30"
    >
      <div className="mx-auto w-full max-w-4xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <Badge className="mb-5">Adoption</Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            One command, then your agent does the rest.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            <span className="font-mono text-foreground">init</span> installs the
            skills and hooks — so a plain-English ask does the work. No config
            to hand-write, no hooks to wire.
          </p>
        </div>

        <ul className="mx-auto mt-12 max-w-2xl space-y-4">
          {SKILLS.map((s) => (
            <li key={s.skill} className="text-base leading-relaxed">
              <span className="font-mono text-accent">
                &ldquo;{s.ask}&rdquo;
              </span>{" "}
              <span className="text-muted-foreground">→ {s.does}</span>
            </li>
          ))}
        </ul>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
          Hooks nudge the agent in-loop — nothing to remember.
        </p>

        {/* The copy-paste agent prompt — the fastest on-ramp. */}
        <div className="reveal mx-auto mt-10 max-w-2xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Paste into Claude Code or Codex
            </span>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy the setup prompt"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-good" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-background/60 px-5 py-4 font-mono text-xs leading-relaxed text-muted-foreground sm:text-sm">
            {AGENT_PROMPT}
          </pre>
          {/* The "works with Claude Code and Codex" line that closed this
              section is gone: the hero chip says it, the label right above this
              block says "Paste into Claude Code or Codex", and the FAQ answers
              it in full. Reassurance once. */}
        </div>
      </div>
    </section>
  );
}
