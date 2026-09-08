import { Star } from "lucide-react";
import { LANGUAGES } from "@/lib/linters";
import { DemoAudit } from "@/components/sections/DemoAudit";

const REPO = "https://github.com/zernie/vigiles";

export function Hero() {
  return (
    <header className="hero-glow relative overflow-hidden">
      {/* Top nav — logo + a single quiet star pill (the only GitHub CTA up top). */}
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <img
            src="./logo.png"
            alt=""
            className="h-8 w-8 rounded-md"
            width={32}
            height={32}
          />
          <span className="text-lg font-semibold tracking-tight">vigiles</span>
        </a>
        <div className="flex items-center gap-5">
          <a
            href="#try"
            className="hidden text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground sm:inline"
          >
            Grade a repo
          </a>
          {/* The docs are a directory away and used to be unreachable from the
              top of the page — a visitor who wanted detail had to guess. */}
          <a
            href="#docs"
            className="hidden text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground sm:inline"
          >
            Docs
          </a>
          <a
            href={REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover:border-accent/50 hover:text-foreground"
          >
            <Star className="h-3.5 w-3.5" aria-hidden />
            Star on GitHub
          </a>
        </div>
      </nav>

      {/* Hero content — headline + ONE primary action, then the real product shot. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pb-10 pt-14 text-center sm:pt-20">
        {/* The headline names the FELT problem, not the tool's verbs. It used
            to read "Audit, test and measure your agent harness" — accurate, and
            a stranger could not tell from it whether this was about their
            CLAUDE.md or about model evals. The pain sentence that used to open
            the paragraph is the headline now; the verbs live one screen down in
            the verb map, where a reader who has decided to care will read them. */}
        <h1 className="text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          {/* Two block spans, not a <br>: the setup and the punchline break at
              EVERY width. A responsive <br> collapsed them onto one line on a
              phone, where "…every PR. Nobody reviews…" reads as one run-on. */}
          <span className="block text-muted-foreground">
            You review every PR.
          </span>
          <span className="block">Nobody reviews your CLAUDE.md.</span>
        </h1>

        {/* Three facts, one sentence each: what it checks, what it proved, and
            how little work adopting it is.

            ── THE CLAIM ─────────────────────────────────────────────────
            Only two, and neither is about anyone else: vigiles checks the
            things a skill or hook NAMES, and the disaster battery scored
            2 of 7 against 7 of 7.

            ── WHAT BACKS IT ─────────────────────────────────────────────
            The battery is `src/hook-dogfood.test.ts`, model-free, in CI, and
            the same numbers render in the proof section from
            `Guard.tsx`'s CI-pinned rows. The reason the sentence claims
            nothing about OTHER tools is `node tools/measure-validate-overlap.mjs`
            (Claude Code 2.1.263, 2026-09-08): on a repo-local `.claude/`
            harness `claude plugin validate` flagged 0 of 7 planted defects,
            and on a packaged plugin exactly 1 — a typo'd hook event. One
            genuine overlap is a fine thing to state where it can be stated
            precisely, which is the problem section, not here.

            ── WHAT THE EARLIER VERSION SAID, AND WHY IT WAS WRONG ───────
            "Nothing checks that the tools, events, files and rules your skills
            and hooks name actually exist." Two separate faults. It is a
            universal negative over every tool that exists, which nobody can
            measure and which therefore should never have been written. And on
            its own terms it is false for one of its four nouns: EVENTS are
            checked, in plugin form. The reader most likely to notice is a
            plugin author — the exact reader this page is for — and the command
            that disproves it is already on their machine.

            ── WHAT WOULD INVALIDATE IT ──────────────────────────────────
            A change to the battery would move 2/7 or 7/7; the CI test is what
            catches that, not this comment. The reason for the silence about
            other tools survives a vendor release either way: the more
            `validate` grows, the more right it was to stay quiet here. */}
        <p className="mt-5 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground sm:text-xl">
          Your skills and hooks name tools, events, files and linter rules. One
          command checks each one is real and grades the result — no key,
          nothing uploaded. Compile your safety hook, too: the widely-copied
          hand-written one blocks 2 of 7 disasters, the compiled rewrite blocks
          7. Then say &ldquo;test my skills&rdquo; and the agent writes the
          test.
        </p>

        {/* The "is this for me?" strip. It answers the three questions a
            stranger asks in the first ten seconds — which harness, which
            language, what licence — and used to be the last sentence of the
            SECOND section, where nobody deciding whether to keep reading ever
            got to it. */}
        <ul className="mt-7 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          {[
            "Claude Code · Codex",
            // The languages, NAMED. This chip read "Any language · 11 linter
            // catalogs" until 2026-09-08 — an overclaim ("any" is eleven
            // specific ecosystems) wrapped around a term a cold visitor cannot
            // gloss. A Python developer scanning on a phone has to see the word
            // Python before deciding to scroll, and never did: Ruff and Pylint
            // were named only in a strip two screens down.
            //
            // Still DERIVED, never typed — `LANGUAGES` is computed from the
            // engine's `BUILTIN_LINTERS`, and `linters.browser.test.ts` fails
            // if a shipped linter has no language decision, so a new linter
            // cannot leave a stale list on the first screen. Same guarantee the
            // count had; more useful answer.
            LANGUAGES.join(" · "),
            "MIT",
          ].map((fact) => (
            <li
              key={fact}
              className="rounded-full border border-border px-3 py-1"
            >
              {fact}
            </li>
          ))}
        </ul>
      </div>

      {/* Product shot on the fold — the LIVE demo (combobox + real grading), not a
          static sample. Its default view is an instant baked featured grade, so the
          first paint has no spinner; type a repo to grade your own. */}
      <div className="mx-auto w-full max-w-3xl pb-20 sm:pb-28">
        <DemoAudit variant="hero" />
      </div>
    </header>
  );
}
