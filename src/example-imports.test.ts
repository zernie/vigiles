/**
 * Every relative import in a runnable example must RESOLVE.
 *
 * 🔴 WRITTEN AFTER A REVIEWER FOUND WHAT MY GREPS COULD NOT (2026-08-21). Deleting
 * `src/experimental.ts` left `examples/harness/side-effect-r3.mjs` and
 * `measure-with-service.mjs` importing `../../dist/experimental.js` — a file the
 * build no longer emits. Both would die on `ERR_MODULE_NOT_FOUND` before reaching
 * even their Docker availability check. I had swept the tree for the string
 * `vigiles/experimental`, and a relative path into `dist/` is not that string.
 *
 * This is the SAME class this project has already written down once: after a
 * directory move, a literal path, path segments joined at runtime, a relative
 * import, and a path built inside a regex were four different spellings of one
 * reference, and searching for the first found only the first. A relative `dist/`
 * import is a fifth spelling. The prescribed fix was never "grep more carefully"
 * — it was "resolve every relative import and require the target to exist",
 * which is what this file does.
 *
 * WHY THE EXAMPLES SPECIFICALLY. They are the one body of code here that nothing
 * else checks: `.mjs`, so `tsc` never sees them; outside `src/`, so `npm run lint`
 * never sees them; not imported by any test, so a broken one fails only when a
 * reader runs it — which is to say, in front of the person we were trying to
 * convince. `node --check` would not catch it either: the syntax is fine, the
 * file just is not there.
 *
 * WHY A TEST AND NOT A CI STAGE. It costs milliseconds inside a job that already
 * runs, versus a new job paying setup + checkout + install for the same answer.
 * This repo's CI budget rule is explicit about that trade.
 *
 * VERIFIED BY MUTATION, both halves and both directions (2026-08-21), each with
 * a grep proving the patch actually landed before the run:
 *   1. point `side-effect-r3.mjs` back at the deleted `dist/experimental.js`
 *      (the reviewer's exact finding)          → fails, naming the file and the
 *                                                 two paths it looked for;
 *   2. the same, but with a stale `dist/experimental.js` TOUCHED ONTO DISK first
 *      → still fails. That is the whole point of judging by source: this is the
 *        run that would have gone green under the obvious implementation.
 *
 * SCOPE, stated so the silence is readable: relative specifiers only. A bare
 * specifier (`vitest`, `node:fs`) is a dependency question and belongs to the
 * package manager, not here. Dynamic `import()` with a computed path cannot be
 * resolved statically and is not attempted.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// `__dirname`, NOT `import.meta.dirname` — this package builds to CommonJS, and
// `tsc` rejects `import.meta` in a file destined for CJS output (TS1470). The
// sibling tests in scripts/ use `import.meta.dirname` legitimately, because
// scripts/ is outside the tsc build; copying that idiom into src/ breaks the
// build while `vitest` stays green, since vitest strips types and never
// typechecks. That is exactly how this line shipped red the first time.
const REPO = resolve(import.meta.dirname, "..");
const EXAMPLES = join(REPO, "examples");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `from "…"` / `import "…"` / `import("…")`, static specifiers only. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

test("every relative import in examples/ resolves to a file that exists", () => {
  const files = walk(EXAMPLES);
  // A scan that finds nothing is either "nothing to check" or "I looked in the
  // wrong place", and only the code can tell them apart. Here it is always the
  // latter — this directory is the point of the test.
  assert.ok(files.length > 0, "found no example files to check");

  const broken: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);

      // A `dist/` target is a BUILD ARTIFACT, and it is judged by its SOURCE
      // alone — never by whether the artifact happens to be on disk.
      //
      // 🔴 The obvious spelling here is "the artifact OR its source", and it is
      // wrong in a way this repo had just been bitten by, an hour before this
      // file was written. `tsc` does not clean `dist/`, so a deleted module
      // leaves its last build behind — and `api:check` spent this whole PR
      // reporting "verified for 11 entries — no drift" while reading exactly such
      // a ghost, for a source file that no longer existed. Accepting the artifact
      // here would rebuild that blind spot: the very import this test exists to
      // catch would pass locally (stale `dist/` present) and fail only on a clean
      // checkout, which is the worst place to learn it.
      //
      // Judging by source also makes the test work on a tree with no build at
      // all, which is the other half of why it is written this way.
      const inDist = target.startsWith(`${REPO}/dist/`);
      const fromDist = target.replace(`${REPO}/dist/`, `${REPO}/src/`);

      // `.js` in the specifier, `.ts` on disk, is not a mistake — it is the
      // NodeNext/ESM convention, and every `.md.spec.ts` under examples/ writes
      // its import that way. Both spellings count as resolved.
      const asTs = (p: string) => p.replace(/\.js$/, ".ts");
      const candidates = inDist
        ? [fromDist, asTs(fromDist)]
        : [target, asTs(target)];

      if (candidates.some((c) => existsSync(c))) continue;
      broken.push(
        `${file.slice(REPO.length + 1)} → ${spec}  (looked for ${candidates
          .map((c) => c.slice(REPO.length + 1))
          .join(" and ")})`,
      );
    }
  }
  assert.deepEqual(
    broken,
    [],
    `example(s) import something that does not exist:\n  ${broken.join("\n  ")}`,
  );
});
