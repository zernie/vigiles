import { ChevronRight, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** The four verbs over one engine — the "one tool, not four" frame. Each row is a
 *  clickable summary (command · what it answers · model note) that EXPANDS to a
 *  plain-English explanation + a concrete example, because a one-line label doesn't
 *  actually tell you what `lint` vs `test` vs `eval` do. */
const VERBS: {
  verb: string;
  answers: string;
  model: string;
  /** What the verb actually does, in plain words. */
  detail: string;
  /** The broken / unproven state vigiles CATCHES (rendered red). */
  before: string;
  /** The correct / verified state you reach (rendered green). vigiles tells
   *  red from green — it doesn't rewrite your code, so "after" is the fix,
   *  never an auto-fix. */
  after: string;
  /** An optional "read more" link shown under the example. */
  link?: { href: string; label: string };
}[] = [
  {
    verb: "audit",
    answers: "Everything, graded A–F",
    model: "no model · read-only · anytime",
    detail:
      "The zero-config front door. One command reads your whole harness and grades it across six categories — truthful references, skills that trigger, sound structure, safety, deterministic test coverage, and whether anything has measured that your skills actually fire. Nothing executes; it's a local report, like Lighthouse.",
    // 🔴 This said `"Setup"` — "no such event" — until 2026-09-08. `Setup` IS a
    // real Claude Code hook event, with its own "Setup input" and "Setup
    // decision control" sections in the vendor's docs; the engine's own catalog
    // learned that on 2026-08-17 (it held 9 of the 31 documented events, and
    // `Setup` was the absentee close enough to `Stop` to get ACCUSED rather
    // than ignored — see adapters/claude-code/vocabulary.ts). The example
    // outlived the fix, so the page demonstrated `audit` catching a hook that
    // works. Verified both ways against Claude Code 2.1.263: `claude plugin
    // validate` passes a manifest registering `Setup`, and warns "unknown hook
    // event" on `PreToolUze` — so the replacement is a real typo, not another
    // guess. Re-run `node tools/measure-validate-overlap.mjs` after a CC minor.
    before: 'hook on event "PreToolUze" — no such event, never fires',
    after: 'hook on event "PreToolUse" — fires before every tool call',
  },
  {
    verb: "lint",
    answers: "Do the structural checks pass?",
    model: "no model · CI gate, every push",
    detail:
      "The CI gate. The same deterministic checks as audit, but as a build step that FAILS the PR when something's broken — a subagent pointing at a tool that doesn't exist, a hook on a misspelled event, two skills that collide. No model, runs on every push.",
    before: "subagent tools: [AskUserQuestion] — not a real tool → build fails",
    after: "subagent tools: [Read, Grep] — real tools → build passes",
  },
  {
    verb: "test",
    answers: "Does the harness behave?",
    model: "no model · scripted stand-in · every commit",
    detail:
      "Runs your actual hooks and skills against a scripted stand-in model — deterministic, no API key. Proves a safety hook really blocks a dangerous command, or that a skill wires into the assembled machine and fires. The cheap middle tier: real harness, fake model.",
    before:
      "pre-push hook exits 1 on `git push --force` — looks like it blocks",
    after: "pre-push hook exits 2 — actually blocks the push",
  },
  {
    verb: "eval",
    answers: "Does a skill actually help?",
    model: "needs a model · your subscription · on demand",
    detail:
      "The one tier that needs a real model — run on YOUR Claude subscription, not a metered API. Measures whether a skill's description makes it FIRE when it should (recall) and stay quiet otherwise (precision), and whether its guidance actually moves the agent's behavior — so you can tell a real win from a claimed one.",
    // The CLAIMED figure is 65%, not the 75% that stood here until 2026-09-08.
    // Three places in this repo say 65% — the README's measurement block twice
    // and docs/measuring-skills.md — as does the post the row links to. A
    // debunk that misquotes the claim it is debunking is the one number on the
    // page a reader can check in ten seconds, so it was the worst one to get
    // wrong. The measured −6% was already right and matches the README.
    before: "skill claims −65% tokens — an unverified number in a README",
    after: "measured −6% — the real number, on your own model",
    link: {
      href: "https://zernie.com/blog/token-savings-wrong-number/",
      label: "Read the measurement",
    },
  },
];

export function VerbMap() {
  return (
    <section id="how" className="scroll-mt-8 border-t border-border">
      <div className="mx-auto w-full max-w-4xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <Badge className="mb-5">How it works</Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            One tool. Four questions.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            <span className="font-mono text-foreground">audit</span> shows where
            your harness is still vibes. Turning that into verified is four
            commands over one engine — and almost none of it needs a model or a
            key. <span className="text-foreground">Tap any command</span> to see
            what it does.
          </p>
        </div>

        {/* The verb map — each row is a <details>: the summary is the scannable
            command/answer/model line; expanding reveals the plain-English detail +
            a concrete example. Type + dividers, not four boxes. */}
        <div className="mx-auto mt-12 max-w-3xl divide-y divide-border border-y border-border">
          {VERBS.map((v) => (
            <details key={v.verb} className="group">
              <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-4 sm:grid-cols-[10.5rem_1fr_auto]">
                <code className="flex items-center gap-1.5 whitespace-nowrap font-mono text-sm text-accent">
                  <ChevronRight
                    size={13}
                    className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                  $ vigiles {v.verb}
                </code>
                <span className="col-start-1 pl-[1.375rem] text-sm text-foreground sm:col-start-2 sm:pl-0">
                  {v.answers}
                </span>
                <span className="col-start-2 row-start-1 text-xs text-muted-foreground sm:col-start-3 sm:text-right">
                  {v.model}
                </span>
              </summary>
              {/* Expanded explanation — the part the old one-liner never told you.
                  Left pad matches the command column so it lines up under the answer. */}
              <div className="pb-5 pl-[1.375rem] pr-1 sm:pl-[10.5rem]">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {v.detail}
                </p>
                {/* Before → after: red = the broken/unproven state vigiles
                    CATCHES, green = the correct state you reach. Kept inside a
                    <pre> so the 390px mobile-wrap gate covers it. */}
                <pre className="mt-3 grid gap-1 whitespace-pre-wrap break-words rounded-md border border-border bg-card/50 px-3 py-2 font-mono text-xs leading-relaxed">
                  <span className="text-red-400">
                    <span aria-hidden>✗ </span>
                    <span className="sr-only">before: </span>
                    {v.before}
                  </span>
                  <span className="text-emerald-400">
                    <span aria-hidden>✓ </span>
                    <span className="sr-only">after: </span>
                    {v.after}
                  </span>
                </pre>
                {v.link && (
                  <a
                    href={v.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent no-underline transition-colors hover:text-accent/80"
                  >
                    {v.link.label}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </a>
                )}
              </div>
            </details>
          ))}
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">
            One engine, two doors.
          </span>{" "}
          <span className="font-mono text-foreground">audit</span> is the local
          report; <span className="font-mono text-foreground">lint</span> is the
          CI gate that fails the build on the same deterministic checks — broken
          references, tool contracts, dead hooks, skill collisions.
        </p>
      </div>
    </section>
  );
}
