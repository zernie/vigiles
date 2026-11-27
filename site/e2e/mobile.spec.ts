import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile-overflow gate — the deterministic backstop for the layout bugs that
 * shipped to a real phone (a crushed locked row, a clipped `<pre>`, edge-bleed).
 * @vitest/browser has no per-test viewport, so a REAL 390px viewport (a proxy for
 * the S23 Ultra / any narrow phone) lives HERE, in Playwright. The invariant is
 * blunt and un-game-able: after exercising the interactive surfaces (expand every
 * verb, tap a graded chip), the PAGE must never scroll horizontally, and no visible
 * `<pre>` may overflow its own box. If a component bleeds past the viewport, this
 * fails — which is exactly the class of bug that reached the founder's phone.
 */

// A narrow phone. 390px is the common logical width (iPhone 12–15, and close to
// the S23 Ultra's ~384px) — the width where the `sm:` breakpoint is still OFF, so
// the mobile-stacked layouts are the ones under test.
test.use({ viewport: { width: 390, height: 844 } });

/** The document must never scroll horizontally — the whole-page overflow check. */
async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  // Allow 1px for sub-pixel rounding; anything more is a real horizontal bleed.
  expect(
    overflow.scrollWidth,
    `page overflows horizontally by ${String(overflow.scrollWidth - overflow.clientWidth)}px at 390px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** No visible <pre> (code block) may overflow its own container — they must wrap. */
async function expectPreBlocksWrap(page: Page): Promise<void> {
  const overflows = await page.evaluate(() =>
    [...document.querySelectorAll("pre")]
      .filter((el) => el.offsetParent !== null) // visible only
      .map((el) => el.scrollWidth - el.clientWidth)
      .filter((delta) => delta > 1),
  );
  expect(
    overflows,
    `${String(overflows.length)} <pre> block(s) overflow their box at 390px`,
  ).toEqual([]);
}

test("the landing page never bleeds past a 390px viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expectNoPageOverflow(page);
  await expectPreBlocksWrap(page);

  // Expand every disclosure on the page ("Show everything" under the demo
  // report, the FAQ) — each reveals content that can clip on a phone.
  const summaries = await page.locator("details summary").all();
  // Guards: the loop below once matched zero elements (a selector for a deleted
  // section) and passed while checking nothing.
  expect(summaries.length).toBeGreaterThan(0);
  for (const summary of summaries) {
    await summary.click();
  }
  await expectNoPageOverflow(page);
  await expectPreBlocksWrap(page);

  // Tap a graded example chip — swaps the in-frame report for a real graded one
  // (the summary <Report>, the locked-row tease, the category strip).
  await page
    .getByRole("button", { name: /grade [A-F]/ })
    .first()
    .click();
  await expectNoPageOverflow(page);
  await expectPreBlocksWrap(page);
});

// The code blocks wrap on purpose (see CodeBlock.tsx), which is fine for a long
// string but turns an explanatory comment into two half-lines that read as noise
// on a phone. A comment is prose we write, so we keep it short enough to fit.
test("a code comment fits on one line at 390px", async ({ page }) => {
  await page.goto("/");
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll("pre > div")]
      .filter((line) => (line as HTMLElement).offsetParent !== null)
      .filter((line) => (line.textContent ?? "").trim().startsWith("//"))
      .map((line) => ({
        text: (line.textContent ?? "").trim(),
        rows:
          line.getBoundingClientRect().height /
          parseFloat(getComputedStyle(line).lineHeight),
      })),
  );
  // Guards: a selector that matches nothing would pass while checking nothing.
  expect(lines.length).toBeGreaterThan(0);
  // Guards: a comment line that wraps into two rows on a phone.
  expect(lines.filter((l) => l.rows > 1.5).map((l) => l.text)).toEqual([]);
});
