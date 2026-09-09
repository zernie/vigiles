import { ROWS } from "@/comparison/rows";

/**
 * The bridge to /comparison.
 *
 * 🔴 WHY IT EXISTS AT ALL, and it is an embarrassing reason. `/comparison` was
 * built, tested, snapshot-pinned and shipped — and linked from NOWHERE. Fable's
 * cohesion review greppped the site on 2026-09-09 and found zero inbound links.
 * A page with no inbound link is not a page; it is a file. The whole argument
 * for building it was discovery (an LLM web search surfaces comparison pages),
 * and that argument survives an unlinked page, which is exactly why nobody
 * noticed: the thing it was for does not need the site to link it.
 *
 * WHAT IT IS NOT. Not a beat. It carries no failure, no measurement and no
 * command, so it deliberately does not use the beat format — it is a pointer,
 * one paragraph and a link, sized so a scroller can skip it in one beat of
 * attention. Ernie chose "small section linking it" over an FAQ line so that a
 * reader who is comparing tools finds it while scrolling rather than only by
 * opening the right question.
 *
 * THE COUNT IS DERIVED, never typed. `ROWS` is the same array the page renders,
 * so a row added or removed there moves this sentence with it — the standing
 * rule that a number in prose goes stale silently.
 */

const CHECK_COUNT = ROWS.length;

export function Compare() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto w-full max-w-4xl px-6 py-14 sm:py-16">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Working out how this sits next to the other things in your harness?
          There is a page for that: {CHECK_COUNT} checks, each one either
          measured against a real harness or marked as not measured, with the
          probe that produced the cell.{" "}
          <a
            href="./comparison/"
            className="text-accent no-underline transition-colors hover:text-accent/80"
          >
            See the comparison
          </a>
          .
        </p>
      </div>
    </section>
  );
}
