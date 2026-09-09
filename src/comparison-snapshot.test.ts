/**
 * The UPKEEP CONTRACT behind the /comparison page.
 *
 * Every measured cell on that page is a claim about SOMEBODY ELSE'S product, so it
 * rots the moment Anthropic ships. Four such claims had to be deleted from this
 * repository on 2026-09-08/09 for exactly that reason, and each had been written from
 * prose rather than a run. The snapshot removes the first failure (a hand-typed cell);
 * this test removes the second (a cell that was measured once and quietly aged).
 *
 * It does NOT re-run the probe. A red build here must never mean "Anthropic shipped a
 * release" — that is not a defect in this repo, and a gate that fires on someone else's
 * calendar gets disabled. It checks only that the STAMP is current, the same
 * distinction eval-lock.ts draws between a committed integrity stamp and a cache.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `__dirname`, NOT import.meta: src/ compiles to CommonJS, where import.meta is a
// tsc error (TS1470) even though vitest — which strips types — runs it happily. The
// idiom is legal one directory over in scripts/, which is outside the build. At
// runtime this file lives in dist/, so the repo root is one level up.
// Root-owned ON PURPOSE. A root test must not read a file under site/: ci.yml skips the
// root jobs for a site-only diff, so such a read merges green and breaks main (#219). The
// snapshot is written by a root tool and asserted here, so it lives at the root and the
// site imports it through the `@measured/…` alias. Guarded by src/ci-path-filter.test.ts.
const SNAPSHOT = resolve(
  __dirname,
  "..",
  "tools/measured/validate-overlap.json",
);

interface Snapshot {
  tool: string;
  version: string;
  measuredAt: string;
  cases: { id: string; rule: string; flagged: boolean }[];
}
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;

/** major.minor — a patch bump is not worth a red build. */
const minorOf = (v: string): string => /^(\d+\.\d+)/.exec(v)?.[1] ?? "";

function installedClaude(): string | null {
  try {
    return execFileSync("claude", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

describe("the /comparison snapshot", () => {
  it("carries the provenance every rendered cell cites", () => {
    expect(snapshot.tool).toBe("claude plugin validate");
    expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(snapshot.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.cases.length).toBeGreaterThan(0);
  });

  it("records a verdict for every case, so no cell renders from a gap", () => {
    for (const c of snapshot.cases) {
      expect(c.id, "case id").toBeTruthy();
      expect(typeof c.flagged, `flagged for ${c.id}`).toBe("boolean");
    }
  });

  it("is not stale against the installed Claude Code", () => {
    const installed = installedClaude();
    if (installed === null) {
      // LOUD skip: no `claude` here means the freshness question was NOT answered.
      console.warn(
        "⊘ SKIPPED freshness — `claude` is not on PATH, so snapshot staleness is UNCHECKED",
      );
      return;
    }
    const have = minorOf(installed);
    const stamped = minorOf(snapshot.version);
    expect(
      have,
      `The /comparison page cites ${snapshot.tool} ${snapshot.version}, but the installed Claude Code is ${installed}. ` +
        `Every measured cell on that page may now be false. Re-measure and commit:\n` +
        `  node tools/measure-validate-overlap.mjs --json tools/measured/validate-overlap.json`,
    ).toBe(stamped);
  });
});
