/**
 * Doc-test-script coverage — the SIBLING of `doc-command-coverage.ts`, aimed at
 * the other reader. That one checks code→docs for the CLI's public VERBS (does
 * every verb a USER can type have a doc home under `docs/`?). This one checks
 * the same direction for this repo's own `test:*` npm scripts: does every tier a
 * CONTRIBUTOR can run appear on the tier map in `CONTRIBUTING.md`?
 *
 * WHY IT IS A CHECK AND NOT A NOTE, measured 2026-09-07. `CONTRIBUTING.md`'s
 * `### Test` section described ONE tier — `npm test` under vitest — while
 * `package.json` shipped nine `test:*` scripts and CI ran four jobs across them.
 * A contributor reading the only map this repo has could not learn that
 * `npm run test:harness` exists, let alone that it is the tier three agents
 * skipped in a single day while reporting the gates green. A hand-written map
 * goes stale the moment a script is added and nothing notices — the same failure
 * the verb list already has a check for, one directory over.
 *
 * HIGH-PRECISION, biased AGAINST crying wolf, for the sibling's reason: a false
 * "undocumented" alarm on a tier that IS on the map costs the build, while a
 * miss costs one row. So a mention is matched GENEROUSLY — the script name
 * anywhere in the prose counts, because a name like `test:harness` cannot
 * collide with an English word the way `test` and `audit` do. The only thing the
 * lookarounds buy is that a LONGER script name is never read as a shorter one
 * (`test:unit-extra` does not document `test:unit`).
 *
 * Scope is the `test:` PREFIX, deliberately. Bare `npm test` is the vitest
 * suite, named in the map as prose; every other script (`build`, `lint`,
 * `check`, …) is a gate, and gates are covered by `npm run check` printing its
 * own list rather than by a doc that would restate it.
 */

/** The prefix that makes an npm script a test TIER rather than a gate. */
export const TEST_SCRIPT_PREFIX = "test:";

/**
 * The `test:*` script names in a `package.json` `scripts` object, sorted so the
 * caller's report is stable.
 */
export function testTierScripts(
  scripts: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(scripts)
    .filter((name) => name.startsWith(TEST_SCRIPT_PREFIX))
    .sort();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `script` is named anywhere in `content`. Generous on purpose (see the
 * file header); the lookarounds only stop a longer script name from counting as
 * a shorter one.
 */
export function scriptMentioned(script: string, content: string): boolean {
  return new RegExp(
    String.raw`(?<![\w:.-])${escapeRegExp(script)}(?![\w:.-])`,
  ).test(content);
}

/**
 * Find `test:*` scripts not named in any of the given doc files. Pure — the
 * caller supplies both the scripts and the file contents, so it runs over this
 * repo in a test or over any other file set.
 */
export function findUndocumentedTestScripts(
  docs: readonly { readonly path: string; readonly content: string }[],
  scripts: Readonly<Record<string, string>>,
): string[] {
  return testTierScripts(scripts).filter(
    (name) => !docs.some((d) => scriptMentioned(name, d.content)),
  );
}
