/**
 * The four verbs, as a STRIP under the demo — what used to be the `VerbMap`
 * section ("One tool. Four questions.", a 1,036px centered explainer with
 * expandable rows).
 *
 * WHY IT IS A STRIP AND NOT A SECTION (2026-09-09). The page had no ordering
 * principle — it was the order the passes were written in — so orientation
 * ("here are the four commands") sat SIX SCREENS BELOW the three sections that
 * assume you already have it. Ernie, looking at the built page: "crowded as
 * fuck", "it feels like few sites slapped together".
 *
 * The fix keeps the orientation and drops the section. A reader needs to know
 * the verbs exist BEFORE the beats, and needs about eight seconds for it, not a
 * screen. So the map is four rows here, and each verb reappears as the mono
 * kicker of the beat that proves it (`$ vigiles test · no model · free in CI`).
 * That is the whole of the old section's job, done in the two places it is
 * actually needed.
 *
 * WHAT WAS DELIBERATELY DROPPED with the section, so nobody restores it by
 * reflex: the per-verb expandable before/after examples. They were good, and
 * they were a third format on a page whose complaint was that it had four. They
 * live in the docs, which the last row links.
 *
 * ORDERING CONSTRAINT: `audit` is first and is the one the demo above already
 * played. The other three are ordered as the page proves them — test, compile,
 * eval — so this strip reads as a table of contents for the scroll, not as a
 * feature list.
 */

const DOCS = "https://github.com/zernie/vigiles/blob/main/docs";

const VERBS: {
  verb: string;
  answers: string;
  cost: string;
  /** Anchor of the beat that proves it, when the page has one. */
  href?: string;
}[] = [
  { verb: "audit", answers: "Everything, graded A–F", cost: "no model" },
  { verb: "lint", answers: "Same checks, as a CI gate", cost: "no model" },
  {
    verb: "test",
    answers: "Does the harness behave?",
    cost: "no model",
    href: "#test",
  },
  {
    verb: "eval",
    answers: "Does a skill actually fire?",
    cost: "your subscription",
    href: "#eval",
  },
];

export function VerbStrip() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto w-full max-w-4xl px-6 py-14 sm:py-16">
        <p className="text-sm leading-relaxed text-muted-foreground">
          That is one of four commands over the same engine. Three of them never
          call a model.
        </p>

        <div className="mt-6">
          {VERBS.map((v) => {
            const row = (
              <>
                <code className="font-mono text-sm text-foreground">
                  $ vigiles {v.verb}
                </code>
                <span className="text-sm text-muted-foreground">
                  {v.answers}
                </span>
                <span className="font-mono text-xs text-muted-foreground sm:text-right">
                  {v.cost}
                </span>
              </>
            );
            const cls =
              "grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border/60 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_9rem] sm:items-baseline";
            return v.href ? (
              <a
                key={v.verb}
                href={v.href}
                className={`${cls} no-underline transition-colors hover:bg-card/40`}
              >
                {row}
              </a>
            ) : (
              <div key={v.verb} className={cls}>
                {row}
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-sm text-muted-foreground">
          The two below are the ones a graded read cannot answer.{" "}
          <a
            href={`${DOCS}/README.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent no-underline transition-colors hover:text-accent/80"
          >
            All four, in detail
          </a>
          .
        </p>
      </div>
    </section>
  );
}
