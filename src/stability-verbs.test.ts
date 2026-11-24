/**
 * STABILITY.md's verb list must be the REAL verb list.
 *
 * Reported by an adopter (#176.4): the page promising a stable CLI contract
 * listed `scan`, a verb removed when it became `audit` — so the strongest
 * promise in the repo named a command that answers `Unknown command`. The
 * heaviest kind of doc drift, and the kind that survives longest, because the
 * page is read by people deciding whether to depend on the tool at all.
 *
 * `self-command-refs` could not catch it and still cannot: it is deliberately
 * high-precision and only inspects a `vigiles <cmd>` reference in a COMMAND
 * context, while STABILITY.md names its verbs as a prose list of backticked
 * words. That measured limit is documented; this test closes the one page where
 * the cost of the gap is highest, without widening the detector into the
 * false-positive territory that got `doc-refs` disabled.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { VERBS } from "./cli-commands.js";

const STABILITY = resolve(import.meta.dirname, "..", "STABILITY.md");

/** The backticked words in the "the verbs (…)" clause. */
function listedVerbs(md: string): string[] {
  const m = /the verbs \(([^)]*)\)/s.exec(md);
  assert.ok(m, "STABILITY.md must carry a `the verbs (…)` clause");
  return [...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1] as string);
}

test("every verb STABILITY.md promises actually exists", () => {
  const listed = listedVerbs(readFileSync(STABILITY, "utf-8"));
  const real = new Set<string>(VERBS);
  const ghosts = listed.filter((v) => !real.has(v));
  assert.deepEqual(
    ghosts,
    [],
    `STABILITY.md promises verb(s) the CLI does not have: ${ghosts.join(", ")}`,
  );
});

test("every human-facing verb is promised by STABILITY.md", () => {
  // The other direction. A shipped verb missing from the stability page is the
  // quieter half of the same drift — the contract silently under-promises, and
  // nobody notices because nothing is wrong on screen.
  const listed = new Set(listedVerbs(readFileSync(STABILITY, "utf-8")));
  // `hook-runtime` is the hidden runtime umbrella — emitted into hook configs,
  // never typed by a human — so it is correctly absent from a human contract.
  const missing = VERBS.filter((v) => v !== "hook-runtime" && !listed.has(v));
  assert.deepEqual(
    missing,
    [],
    `these verbs ship but STABILITY.md does not mention them: ${missing.join(", ")}`,
  );
});
