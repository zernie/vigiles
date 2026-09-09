import { StickyCTA } from "@/components/StickyCTA";
import { Toaster } from "@/components/ui/toaster";
import { Hero } from "@/components/sections/Hero";
import { MeasureTest, MeasureEval } from "@/components/sections/Measure";
import { Guard } from "@/components/sections/Guard";
import { Adoption } from "@/components/sections/Adoption";
import { Compare } from "@/components/sections/Compare";
import { FAQ } from "@/components/sections/FAQ";
import { CTA } from "@/components/sections/CTA";
import { Footer } from "@/components/Footer";

/**
 * THE PAGE ORDER IS THE ARGUMENT — read this before adding a section.
 *
 * Until 2026-09-09 the order was the order the passes were WRITTEN in: demo,
 * then the problem, then two proofs, then a third proof, then the map that
 * explains the verbs. Ernie, looking at the built page: "crowded as fuck" and
 * "it feels like few sites slapped together". Measured at the time: 12,211 CSS
 * px, roughly fourteen laptop screens, in four unrelated layout languages.
 *
 * The spine is now FAILURE → COMMAND. Every beat between the demo and the CTA
 * names a bug a plugin author has already lived through, shows what we measured
 * on a real repo, and ends in the one command that catches it:
 *
 *   Hero        audit — the graded read, played live on a repo you recognise,
 *               closing on ONE line that names `lint` (the CI gate, the only
 *               verb with no beat) and hands off to the three below
 *   MeasureTest test    — your safety hook: what does it actually stop?
 *   Guard       compile — a widely-copied hook blocks 2 of 7
 *   MeasureEval eval    — your skill has a description; does it fire?
 *   Adoption    the agent does the work: one command, then a prompt
 *   Compare     the pointer to /comparison (which was linked from NOWHERE)
 *   FAQ · CTA   the two objections that stop a run, then the ask
 *
 * WHAT LEFT, and why, so it is not restored by reflex:
 *
 *  - `Wedge` (the four warning cards) — its cards WERE the davila7 findings the
 *    demo directly above had just rendered. The fold echoed into the report.
 *  - `VerbMap` ("One tool. Four questions.") — DISTRIBUTED into each beat's mono
 *    kicker. It first became a four-row `VerbStrip` under the hero; that strip
 *    lasted one review, because three of its four rows repeated an adjacent
 *    kicker or the demo, and its "four commands" omitted `compile`, which the
 *    page proves one screen later. What was genuinely load-bearing — one engine,
 *    and `lint` as the CI gate — is one sentence in the hero now.
 *  - `Docs` (a link list) — the footer already carries every link it had.
 *
 * THE ONE FORMAT every beat uses, and the reason the page reads as one site:
 * left-aligned in a single max-w-4xl rail · mono kicker `$ vigiles <verb> ·
 * <cost>` · `h2` naming the failure in the reader's words · a two-line lead
 * saying which REAL repo and what happened · ONE artifact (verdict rows,
 * battery table, prompt table) with every number from a fixture · optional
 * code · ONE closing line, the command or the guide link.
 *
 * Banned on this page, because each was a fifth format: `Badge` kickers,
 * centered section headers, Card grids, three-column "why" grids, caveat boxes
 * (a caveat is one line plus the docs link). The hero is the single exception —
 * it stays centered, because it is the demo rather than a beat — as does the
 * closing CTA, so the page OPENS and CLOSES centered (the pitch, then the ask)
 * with left-rail evidence between them. That is a bookend, deliberately, and
 * the reason `Adoption` and `FAQ` moved INTO the rail on 2026-09-09: they are
 * content, and content that sits centered between left-aligned neighbours reads
 * as a seam. Two centered bands at the two ends read as a frame.
 */
export function App() {
  return (
    <>
      <StickyCTA />
      <main className="min-h-screen">
        <Hero />
        <MeasureTest />
        <Guard />
        <MeasureEval />
        <Adoption />
        <Compare />
        <FAQ />
        <CTA />
        <Footer />
      </main>
      <Toaster />
    </>
  );
}
