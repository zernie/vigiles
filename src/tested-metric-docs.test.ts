/**
 * The DOCUMENTED Tested metric must match the one the detector implements.
 *
 * 🔴 WHY THIS FILE EXISTS. Dropping `*.test.*` from `DEFAULT_TEST_GLOBS` was an
 * intentional breaking change, and for a while the code did one thing while the
 * public docs said another: `docs/cli.md` and `docs/non-js-harnesses.md` both
 * still listed `*.test.*` as feeding **Tested**, as did the metric's own comments
 * in `audit-score.ts`, `scan.ts` and `test-coverage.ts`. A user following those
 * docs keeps a colocated `foo.test.ts`, silently loses the Tested credit it used
 * to earn, and gets an untested finding for a skill they did test.
 *
 * A doc defect is not a code defect, so nothing in the suite could catch it. This
 * closes that: the behaviour is asserted against the real detector, and the
 * sentences that DESCRIBE the behaviour are checked against the same fact.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { globSync } from "glob";
import { join, resolve } from "node:path";

import { findUntestedSurfaces } from "./test-coverage.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";

// __dirname is src/ (vitest) or dist/ (built) — both one level under the root.
const ROOT = resolve(__dirname, "..");

const SKILL = [
  "---",
  "name: foo",
  "description: A skill that does foo things across many different cases",
  "---",
  "# foo",
  "",
].join("\n");

function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

test("the BEHAVIOUR: a colocated `foo.test.mjs` does not cover, `foo.harness.mjs` does", () => {
  // The fact every sentence below is checked against. Both halves, because a
  // detector that covered NOTHING would satisfy the first assertion alone.
  const dir = makeTmpDir("tested-metric");
  write(dir, "skills/foo/SKILL.md", SKILL);
  write(dir, "skills/foo/foo.test.mjs", "// followed the pre-15.x advice\n");
  assert.deepEqual(
    findUntestedSurfaces({
      layout: claudeCodeLayout,
      basePath: dir,
    }).untested.map((s) => s.path),
    ["skills/foo/SKILL.md"],
    "`*.test.*` must NOT count — this is the documented breaking change",
  );

  // …and the migration the docs prescribe actually works: a rename, nothing else.
  write(dir, "skills/foo/foo.harness.mjs", "// same file, renamed\n");
  assert.deepEqual(
    findUntestedSurfaces({
      layout: claudeCodeLayout,
      basePath: dir,
    }).untested.map((s) => s.path),
    [],
    "the rename the migration note prescribes must restore the credit",
  );
  cleanupTmpDir(dir);
});

/**
 * A sentence that ENUMERATES what feeds a tier — the shape every one of the five
 * stale claims had: `` (`*.harness.mjs`, `*.test.*`) ``. Naming the harness glob
 * and `*.test.*` on one line is a claim that both count, unless the line is
 * explicitly saying the opposite (the migration note, the "never `*.test.*`"
 * line in `docs/cli.md`).
 *
 * Deliberately narrow. A predicate that flagged every mention of `.test.` would
 * hit this repo's own filenames on hundreds of lines and be muted the same day;
 * this one is quiet on the whole corpus and fires on exactly the retired shape.
 */
const RETIRED_CLAIM = /\*\.test\.\*|\*\.\{test/;
const SAYING_OTHERWISE =
  /never|no longer|NOT count|used to|rename|Changed in|⚠|does not/;

function staleTestedClaims(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (l) =>
        l.includes("*.harness.") &&
        RETIRED_CLAIM.test(l) &&
        !SAYING_OTHERWISE.test(l),
    )
    .map((l) => l.trim());
}

test("no public doc or metric comment still lists `*.test.*` as feeding Tested", () => {
  // FIRES on the exact sentence that shipped — quoted verbatim from docs/cli.md
  // before the fix, so this cannot pass by the predicate having gone inert.
  assert.deepEqual(
    staleTestedClaims(
      "**Tested and Evaluated are two rings, not one number.** A harness\n" +
        "(`*.harness.mjs`, `*.test.*`) is free, runs in milliseconds on every push,",
    ),
    [
      "(`*.harness.mjs`, `*.test.*`) is free, runs in milliseconds on every push,",
    ],
  );
  // …and on the metric comment's shape too.
  assert.equal(
    staleTestedClaims(
      " * DETERMINISTIC coverage only — `*.harness.mjs` and `*.test.*`. Free,",
    ).length,
    1,
  );

  // QUIET on the corrected corpus — every public doc plus the sources that carry
  // the metric's own description.
  const files = [
    ...globSync("docs/**/*.md", { cwd: ROOT }),
    "README.md",
    ...globSync("src/*.ts", { cwd: ROOT }).filter(
      (f: string) => !f.endsWith(".test.ts"),
    ),
  ];
  const offenders: string[] = [];
  for (const rel of files) {
    for (const line of staleTestedClaims(
      readFileSync(join(ROOT, rel), "utf-8"),
    ))
      offenders.push(`${rel}: ${line}`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));

  // …and the sentences that state the CHANGE are actually present, so a future
  // edit cannot satisfy this file by deleting the migration note instead.
  const migration = readFileSync(
    join(ROOT, "docs/rules/untested-skill.md"),
    "utf-8",
  );
  assert.match(migration, /no longer count toward Tested/);
  assert.match(
    migration,
    /foo\.test\.mjs\s+->\s+skills\/foo\/foo\.harness\.mjs/,
  );
  assert.match(
    readFileSync(join(ROOT, "docs/non-js-harnesses.md"), "utf-8"),
    /no longer count/,
  );
});
