import { AlertTriangle } from "lucide-react";
import { LINTER_NAMES } from "@/lib/linters";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const FAILURES: {
  title: string;
  code: string;
  problem: string;
}[] = [
  {
    // 🔴 This card said `event: "Setup"` — "There's no Setup event" — until
    // 2026-09-08. `Setup` IS a real Claude Code hook event, with its own
    // "Setup input" and "Setup decision control" sections in the vendor's docs;
    // the engine's own catalog learned this on 2026-08-17 (it held 9 of the 31
    // documented events, and `Setup` was the absentee close enough to `Stop` to
    // get accused rather than ignored — see `vocabulary.ts`). The card outlived
    // the fix, so the page's FIRST example of "config that parses and does the
    // wrong thing" was itself a thing that parses and works. Verified both
    // ways against Claude Code 2.1.263: `claude plugin validate` passes a
    // manifest registering `Setup`, and warns "unknown hook event; entry
    // ignored at runtime" on `PreToolUze`.
    title: "A hook on a made-up event",
    code: 'event: "PreToolUze"',
    problem:
      "One letter off, so the hook is never wired to anything. The config is valid YAML — it just does nothing.",
  },
  {
    title: "A silently-dropped tool",
    code: "tools: [Read, AskUserQuestion]",
    problem:
      "AskUserQuestion isn't a real subagent tool. The harness drops it without a word — your agent quietly can't ask.",
  },
  {
    title: "A hook script that isn't there",
    code: "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh",
    problem:
      "The path parses fine. The file was never committed, so the guard you think protects you runs nothing.",
  },
  {
    title: "A skill pointing at a ghost",
    code: "See references/schema.md",
    problem:
      "The skill references a file that doesn't exist on disk. The model follows a link into nowhere.",
  },
];

/** The linters vigiles cross-references a rule against — DERIVED from the
 * engine's `BUILTIN_LINTERS` so the strip can never drift from what's shipped
 * (add a linter there and it appears here automatically). The map moved to
 * `@/lib/linters` when the hero started deriving LANGUAGES from the same
 * source; a test there fails if a shipped linter is missing from either. */
const LINTERS = LINTER_NAMES;

export function Wedge() {
  return (
    <section
      id="wedge"
      className="scroll-mt-8 border-y border-border bg-card/30"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="signal" className="mb-5">
            The problem
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Valid config. Broken agent.
          </h2>
          {/* ── THE CLAIM ─────────────────────────────────────────────────
              `claude plugin validate` catches a malformed manifest, a subagent
              with no description, and a hook on an unknown event — the last of
              those ONLY when the harness is packaged as a plugin. It does not
              catch a tool that does not exist, a hook script that is not on
              disk, or a skill linking to a missing file.

              ── WHAT BACKS IT ─────────────────────────────────────────────
              `node tools/measure-validate-overlap.mjs`, against Claude Code
              2.1.263, on 2026-09-08. It plants seven defects and runs the real
              binary in BOTH shapes a user has:

                repo-local .claude/  → 0 of 7 flagged, default AND --strict
                packaged plugin      → 1 of 7: "hooks.PreToolUze: unknown hook
                                       event; entry ignored at runtime"

              The silence is real silence, not a surface it never opened: the
              same tool errors on invalid manifest JSON and on a hooks.json
              missing its root key, and warns on an agent with no description.

              ── WHAT THE EARLIER VERSIONS SAID, AND WHY THEY WERE WRONG ────
              (1) Until 2026-09-07 this read "Every other tool checks your
              config is well-formed" — a universal nobody had tested.
              (2) It was then replaced with a version conceding that validators
              catch "a hook on an event that doesn't exist" among the things
              vigiles is DIFFERENT from — i.e. listing the one check they DO
              share as one they don't. Both errors came from prose about the
              other tool rather than a run of it, in opposite directions: first
              crediting it with nothing, then mis-sorting the one thing it does.
              (3) A third draft that same day went the other way and credited it
              with tool names, hook scripts, MCP servers and model values. The
              measurement says none of those. Under-crediting a competitor is as
              wrong as over-claiming against one, and it is the easier mistake
              to make on your own landing page.

              ── WHAT WOULD INVALIDATE IT ──────────────────────────────────
              A new Claude Code minor. Re-run the probe; the event row is the
              likeliest to grow, being the only one that already passes. The
              PLUGIN-SHAPE qualifier is load-bearing and easy to drop by
              accident — a repo-local `.claude/` harness, which is the common
              case, gets none of the seven. */}
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Config validators — Anthropic&apos;s own{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-base">
              claude plugin validate
            </code>{" "}
            included — catch a malformed manifest, a subagent missing its
            description, and, if you ship a plugin, a hook on an unknown event.
            vigiles agrees with them there. The failures that bite hardest are
            the ones that parse perfectly and point at nothing: a tool the
            harness silently drops, a script that was never committed, a skill
            linking to a file that isn&apos;t there.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
          {FAILURES.map((f) => (
            <Card key={f.title} className="reveal p-6">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal/10 text-signal">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold tracking-tight">
                    {f.title}
                  </h3>
                  <code className="mt-2 inline-block max-w-full overflow-x-auto rounded-md border border-signal/25 bg-signal/[0.06] px-2.5 py-1 font-mono text-sm text-signal">
                    {f.code}
                  </code>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {f.problem}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* The resolution — one line, then the linter strip as Truthfulness's
            deepest detail.

            Two things came out on 2026-09-08. "one deterministic, model-free
            score across six categories (see the report above)" restated the
            report sitting one screen up, which already shows the six rings —
            the fold-echoes-into-the-report rule. And "the one no other tool
            does" was a universal negative about every tool on earth, which
            nobody can measure; the same shape came out of the hero the same
            day. What the check IS — resolved against YOUR config, exists AND
            enabled — is the useful half and needs no survey to stand up. The
            count went too: the strip below is derived, so a typed "eleven" was
            a stale number waiting to happen. */}
        <div className="mt-16 border-t border-border pt-12">
          <p className="mx-auto max-w-2xl text-center text-lg leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">
              vigiles grades all of it
            </span>{" "}
            — and goes one step deeper on the rules: every linter rule your
            instructions name is resolved against the linter you actually run.
            The rule has to <span className="text-foreground">exist</span>, and
            wherever that linter has an on/off switch, be{" "}
            <span className="text-foreground">enabled</span> in your config:
          </p>
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {LINTERS.map((name) => (
              <li
                key={name}
                className="rounded-md bg-muted/50 px-2.5 py-1 font-mono text-xs text-muted-foreground"
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
