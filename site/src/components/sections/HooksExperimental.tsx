import { Badge } from "@/components/ui/badge";

/**
 * A small, deliberately quiet section for what `compile` (Guard.tsx) used to
 * lead the page with: compiled HOOKS. Added 2026-09-25 when `test`/`compile`
 * were rewritten from hooks to skills (Ernie: hooks don't scare people much,
 * partly because of Claude Code's auto-mode; skills are what most authors
 * ship). The finding this section points at — a widely-copied safety hook
 * blocks 2 of 7 disasters, compiled it blocks 7 of 7 — is unchanged and still
 * real; it just isn't the page's opening argument anymore.
 *
 * 🔴 SANCTIONED EXCEPTION to this page's own banned-patterns list (App.tsx:
 * "Do NOT add: `Badge` kickers..."). Ernie, in the same breath as asking for
 * this section: "пометить плашкой, что там экспериментально" (mark it with a
 * badge, that it's experimental) — a badge here is not decoration, it is the
 * one piece of information this section exists to carry (compiled hooks are
 * `experimental_*` in the API itself, per docs/compiled-hooks.md's own
 * warning banner). One exception, stated once, does not reopen the rule for
 * the next section that wants a badge.
 *
 * 🔴 TODO(2026-09-25, unresolved) — see the longer TODO in Guard.tsx: how do
 * we eventually SELL compiled hooks once they no longer lead the page? Not
 * decided. This section is deliberately the minimum viable pointer, not an
 * attempt to answer that question inline.
 */
export function HooksExperimental() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="text-lg font-semibold text-foreground">
            Hooks compile too
          </h3>
          <Badge variant="accent">Experimental</Badge>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A hand-written hook is opaque shell — the exit code, the JSON field,
          the wiring are all places to get it silently wrong. A widely-copied
          safety hook we measured blocks 2 of 7 real disasters; compiled from a
          typed function against a closed vocabulary, the same hook blocks 7 of
          7, because the bug class it was missing has nowhere left to live.{" "}
          <a
            href="https://github.com/zernie/vigiles/blob/main/docs/compiled-hooks.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent no-underline transition-colors hover:text-accent/80"
          >
            Full guide, caveats included
          </a>
          .
        </p>
      </div>
    </section>
  );
}
