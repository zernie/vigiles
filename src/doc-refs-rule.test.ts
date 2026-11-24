/**
 * `doc-refs` — the WIRING, not the engine.
 *
 * `src/core/doc-refs.test.ts` covers `findDocRefs` itself and is untouched by
 * this change. What changed is whether that engine runs at all: the pass used to
 * be unconditional and unturnoffable, and is now the opt-in `doc-refs` rule,
 * default off.
 *
 * Three tiers, driven through the REAL built CLI on a fixture whose one ref is
 * genuinely broken, because the failure being guarded here is a wiring failure
 * (a rule read from the wrong key, a report field still counted when the rule is
 * off) that a library-level call cannot see:
 *
 *   absent  → the section does not print AND the walk does not happen
 *   "warn"  → the finding prints, marked ℹ, and the exit code is untouched
 *   "error" → the finding prints, marked ✗, and lint exits 2
 *
 * The middle case is the one worth a test. A `✗` printed next to an exit code of
 * 0 is how an advisory rule gets mistaken for a gate, which is precisely how this
 * pass came to be worked around with `continue-on-error` in a consumer repo
 * instead of configured.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

let dir: string;

/** A fixture holding exactly one ref, and that ref is broken. */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-doc-refs-rule-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    ["# Fixture", "", "```ts", 'cmd("npm run nope");', "```", ""].join("\n"),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lintWith(rules: string | undefined): {
  out: string;
  exitCode: number;
} {
  const cfg = join(dir, ".vigilesrc.json");
  if (rules === undefined) rmSync(cfg, { force: true });
  else writeFileSync(cfg, rules);
  const r = spawnSync("node", [CLI, "lint"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    exitCode: r.status ?? -1,
  };
}

describe("the doc-refs rule", () => {
  it("does not run at all when unconfigured — the section is absent, not empty", () => {
    const { out, exitCode } = lintWith(undefined);
    assert.ok(
      !out.includes("Markdown code block refs"),
      `off must skip the pass entirely (that is the subtraction), got:\n${out}`,
    );
    // And the broken ref must not leak into the exit code by another route.
    assert.equal(exitCode, 0, "a repo with only a prose ref must lint clean");
  });

  it('reports but does not gate at "warn", and marks the finding ℹ not ✗', () => {
    const { out, exitCode } = lintWith('{"rules":{"doc-refs":"warn"}}');
    assert.ok(
      out.includes("Markdown code block refs"),
      "warn must still print the section",
    );
    assert.match(out, /broken ref\(s\)/, "warn must still name the finding");
    assert.ok(
      /ℹ 1 broken ref\(s\)/.test(out),
      `warn must not claim the hard marker, got:\n${out}`,
    );
    assert.equal(exitCode, 0, "warn must never change the exit code");
  });

  it('gates at "error", with the hard marker and exit 2', () => {
    const { out, exitCode } = lintWith('{"rules":{"doc-refs":"error"}}');
    assert.ok(
      /✗ 1 broken ref\(s\)/.test(out),
      `error must use the hard marker, got:\n${out}`,
    );
    assert.match(
      out,
      /cmd\("npm run nope"\)/,
      "the finding must name the ref it rejected",
    );
    assert.equal(
      exitCode,
      2,
      "an explicit error rule belongs in the hard tier",
    );
  });
});
