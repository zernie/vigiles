/**
 * DRIFT GUARD for the `test` beat (MeasureTest), added 2026-09-25 alongside
 * the rewrite from hooks (davila7's force-push guard) to skills
 * (trailofbits/skills-curated). Same trick as Guard.browser.test.tsx: the
 * numbers come from __fixtures__/trailofbits-skills.json, a REAL `vigiles
 * test`/`vigiles audit` run against the vendored marketplace slice
 * (scripts/gen-trailofbits-expected.mjs, `pretest:browser`) — never retyped,
 * never asserted against itself.
 */
import { describe, it, expect } from "vitest";
import trailofbits from "./__fixtures__/trailofbits-skills.json";

describe("the test section quotes a real `vigiles test` run against the vendored marketplace", () => {
  it("the harness glob run against the slice found nothing — the whole headline claim", () => {
    expect(trailofbits.testOutput).toMatch(/^no .*files found\.$/i);
  });

  it("surfaces = skills + agents, consistently", () => {
    expect(trailofbits.surfaces).toBe(trailofbits.skills + trailofbits.agents);
  });

  it("the section's plugin/surface counts are plausible, not zeroed out by a broken slice", () => {
    // A malformed or moved vendor slice would most likely read as EMPTY
    // (`vigiles audit` reporting zero plugins), which would silently turn
    // "32 skills, zero tested" into "0 skills, zero tested" — still
    // internally consistent, still wrong. Pin a floor.
    expect(trailofbits.plugins).toBeGreaterThan(10);
    expect(trailofbits.surfaces).toBeGreaterThan(10);
  });
});
