/**
 * CONSUMER-SIDE guard for the hero's language chip — the half that `linters
 * .browser.test.ts` cannot give.
 *
 * That file asserts what `LANGUAGES` IS. This one asserts the first screen
 * actually SHOWS it, by rendering the chip and reading the DOM. Both are needed:
 * a correct `LANGUAGES` that nothing renders, and a hand-typed chip that ignores
 * it, are different defects and neither test sees the other's.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * A ROOT test used to cover the consumer by regexing `Hero.tsx`'s SOURCE for its
 * import line and for the absence of the old "Any language" copy. Two things
 * were wrong with that: it asserted the shape of TEXT (a rename or a reformat
 * breaks it, and a substring cannot tell an assertion from a comment discussing
 * one), and it made a root test read a site file — which is how a site-only PR
 * skipped the root jobs and merged green over a broken root test (#219).
 *
 * Deleting it dropped the consumer half, and Codex caught that on this PR. This
 * is the honest replacement: same property, checked on the RENDERED OUTPUT, in
 * the job that runs for a site diff.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { LANGUAGES } from "@/lib/linters";
import { HeroChip } from "./Hero";

afterEach(cleanup);

/** The chip's own text, from the real DOM. */
function chipText(): string {
  render(createElement(HeroChip));
  return screen.getByText(/Claude Code/).textContent ?? "";
}

describe("the hero chip RENDERS the engine's languages", () => {
  it("shows every language the engine covers", () => {
    const text = chipText();
    expect(LANGUAGES.length).toBeGreaterThan(0); // a vacuous loop proves nothing
    for (const lang of LANGUAGES) expect(text).toContain(lang);
  });

  it("shows them AS THE DERIVATION, not a list that merely overlaps it", () => {
    // The verbatim join is what makes a hand-typed replacement fail the moment
    // BUILTIN_LINTERS moves under it — containment alone would not: a chip
    // naming one extra language, or the right ones in a stale order, passes the
    // loop above and is still wrong.
    expect(chipText()).toContain(LANGUAGES.join(" · "));
  });

  it("never reintroduces the 'Any language' overclaim it replaced", () => {
    expect(chipText()).not.toContain("Any language");
  });
});
