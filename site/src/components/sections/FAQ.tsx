import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const FULL_FAQ = "https://github.com/zernie/vigiles/blob/main/docs/faq.md";

/** The objections a skeptical dev raises first — answered plainly. `a` is a node
 *  so we can bold the key phrase without dangerouslySetInnerHTML.
 *
 *  Two were added on 2026-09-08, because they are the two objections that stop a
 *  run and neither was answered anywhere on the page: a Python developer's "is
 *  this for me?" (the hero named no language until the same day, and Ruff/Pylint
 *  appeared only in a strip two screens down) and everyone's "what will this
 *  bill me?". Per the design bar these are confidence-builders a skeptic
 *  actually asks, not doubt-planters. */
const QA: { q: string; a: ReactNode }[] = [
  {
    // Corrected 2026-09-08: this answer used to say the test half "runs your
    // harness against a model" — the eval tier's description attached to the
    // free one, which made the deterministic tier read as costing money and
    // needing a key. `test` drives a scripted stand-in; only `eval` calls a
    // real model.
    q: "Isn't this just another linter?",
    a: (
      <>
        It includes one — but the checks are about{" "}
        <span className="font-semibold text-foreground">truth</span>, not style:
        every rule, file, and tool your instructions name has to actually exist,
        and a linter rule has to be switched{" "}
        <span className="text-foreground">on</span> in your real config, not
        just spelled right. Then it goes past reading.{" "}
        <span className="font-mono">test</span> runs your real hooks and skills
        against a <em>scripted stand-in</em> model — no key — to prove a hook
        blocks and a skill fires. <span className="font-mono">eval</span> runs
        the real model. No linter does either.
      </>
    ),
  },
  {
    q: "Does it work on a Python repo?",
    a: (
      <>
        Yes. Ruff and Pylint are two of the eleven linters it cross-references:
        a rule your CLAUDE.md or AGENTS.md names — say{" "}
        <span className="font-mono">ruff/F401</span> — is checked to{" "}
        <span className="text-foreground">exist</span> (
        <span className="font-mono">ruff rule</span>,{" "}
        <span className="font-mono">pylint --help-msg=</span>) and to be{" "}
        <span className="text-foreground">enabled</span> in your config (
        <span className="font-mono">ruff check --show-settings</span>,{" "}
        <span className="font-mono">pylint --list-msgs-enabled</span>). vigiles
        ships on npm, but your repo needs no{" "}
        <span className="font-mono">package.json</span> and no{" "}
        <span className="font-mono">npm install</span> —{" "}
        <span className="font-mono">npx vigiles audit</span> runs on its own,
        and Ruff or Pylint only need to be on your PATH. Same for Rust (Clippy),
        Go (golangci-lint), Kotlin and Java (detekt, ktlint, Checkstyle) and
        Ruby (RuboCop).
      </>
    ),
  },
  {
    q: "What does it cost to run?",
    a: (
      <>
        Nothing, for almost all of it. <span className="font-mono">audit</span>,{" "}
        <span className="font-mono">lint</span> and{" "}
        <span className="font-mono">test</span> call no model and make no
        network request. Only <span className="font-mono">eval</span> calls a
        model, and it drives your own <span className="font-mono">claude</span>{" "}
        CLI — so it authenticates the way your CLI already does:{" "}
        <span className="text-foreground">
          no separate API key, no per-token bill
        </span>
        .
      </>
    ),
  },
  {
    q: "What do I have to change to adopt it?",
    a: (
      <>
        Nothing up front. <span className="font-mono">audit</span> and{" "}
        <span className="font-mono">lint</span> read the CLAUDE.md or AGENTS.md
        you already have, as-is — nothing is moved or rewritten. When you like
        what you see, <span className="font-mono">npx vigiles init</span> adds
        the CI gate and installs the skills and hooks, so your agent handles the
        upkeep. <span className="font-mono">eject</span> reverses it.
      </>
    ),
  },
  {
    q: "Does it only work with Claude Code?",
    a: (
      <>
        No. Claude Code and Codex are both first-class for{" "}
        <span className="font-mono">audit</span>,{" "}
        <span className="font-mono">lint</span> and the deterministic{" "}
        <span className="font-mono">test</span> tier — the checks read whichever
        one your repo targets, and <span className="font-mono">compile</span>{" "}
        emits each harness&apos;s native hook config. Real-model{" "}
        <span className="font-mono">eval</span> drives the{" "}
        <span className="font-mono">claude</span> CLI today. If your plugin is
        packaged to{" "}
        <a
          href="https://agent-plugins.org"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          Agent Plugins
        </a>{" "}
        — a packaging format, not another agent — its skills and root{" "}
        <span className="font-mono">mcp.json</span> are audited too.
      </>
    ),
  },
  {
    q: "Can I grade a private repo?",
    a: (
      <>
        Yes — run <span className="font-mono">npx vigiles audit</span> in it
        locally. It reads your working copy off disk, so private repos work with{" "}
        <span className="text-foreground">
          no upload, no account, no server
        </span>{" "}
        — nothing leaves your machine. Only the browser demo above is
        public-only (it calls GitHub&apos;s API to read a repo you name).
      </>
    ),
  },
];

export function FAQ() {
  return (
    <section id="faq" className="scroll-mt-8 border-t border-border">
      <div className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <Badge className="mb-5">FAQ</Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Questions people ask first.
          </h2>
        </div>

        <dl className="mx-auto mt-12 max-w-2xl divide-y divide-border border-t border-border">
          {QA.map((item) => (
            <div key={item.q} className="py-6">
              <dt className="text-base font-semibold tracking-tight text-foreground">
                {item.q}
              </dt>
              <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {item.a}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-10 text-center">
          <a
            href={FULL_FAQ}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-base font-semibold text-accent no-underline transition-colors hover:text-accent/80"
          >
            Full FAQ
            <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}
