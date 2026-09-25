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

  it("the live parse_date bug is real, not retyped — and the control proves it's narrow", () => {
    // Added 2026-09-26 (Ernie asked for a behavioral finding, not just
    // security). Both commands are REAL `runScript` runs against the
    // vendored dates.py, asserted by the generator before it writes the
    // fixture. This pins the rendered copy to the same two outputs.
    expect(trailofbits.dateBug.output).toMatch(/^1970-/);
    expect(trailofbits.dateBug.controlOutput).toMatch(/^2025-/);
    expect(trailofbits.dateBug.plugin).toBe("last30days");
  });
});
