import { BUILTIN_LINTERS } from "@engine/spec";

/**
 * The linter metadata the page DERIVES from the engine, in one place.
 *
 * Both maps are keyed by the engine's `BUILTIN_LINTERS`, and
 * `linters.browser.test.ts` asserts every shipped linter has an entry in each —
 * so adding a linter to the engine cannot leave the front page describing the
 * old set. That test is the whole reason these live here rather than beside the
 * one component that happened to need them first.
 */

/** Display casing (the engine's `BUILTIN_LINTERS` is lowercase). A linter with
 *  no entry renders under its own lowercase name — detekt / ktlint /
 *  golangci-lint are their canonical branding — so the fallback is correct, not
 *  a gap. */
export const LINTER_LABELS: Record<string, string> = {
  eslint: "ESLint",
  stylelint: "Stylelint",
  ruff: "Ruff",
  clippy: "Clippy",
  pylint: "Pylint",
  rubocop: "RuboCop",
  cedar: "Cedar",
  checkstyle: "Checkstyle",
};

/**
 * The LANGUAGE a reader would go looking for themselves under — `null` when the
 * linter's subject is not a language someone writes their project in.
 *
 * `null` is a DECISION, not a missing entry, which is why the type is
 * `string | null` and the test requires a key for every linter: Stylelint reads
 * CSS and Cedar reads authorization policies, and neither belongs in a strip
 * that answers "is my language covered?". Both still appear by name in the
 * Wedge's linter strip, where the question is "which linters", not "which
 * languages".
 */
export const LANGUAGE_OF: Record<string, string | null> = {
  eslint: "TypeScript",
  ruff: "Python",
  pylint: "Python",
  clippy: "Rust",
  "golangci-lint": "Go",
  detekt: "Kotlin",
  ktlint: "Kotlin",
  checkstyle: "Java",
  rubocop: "Ruby",
  stylelint: null,
  cedar: null,
};

/** The linter names, display-cased — the Wedge's strip. */
export const LINTER_NAMES: readonly string[] = BUILTIN_LINTERS.map(
  (l) => LINTER_LABELS[l] ?? l,
);

/**
 * The languages, de-duplicated, in the fixed order below rather than in
 * `BUILTIN_LINTERS` order — the strip is read left-to-right by a stranger
 * deciding whether to keep scrolling, so it leads with the two the audience is
 * most likely to be in. A language that is covered but unlisted here would be a
 * silent omission, so the test asserts this list and the map agree in BOTH
 * directions.
 */
export const LANGUAGE_ORDER: readonly string[] = [
  "TypeScript",
  "Python",
  "Rust",
  "Go",
  "Kotlin",
  "Java",
  "Ruby",
];

export const LANGUAGES: readonly string[] = LANGUAGE_ORDER.filter((lang) =>
  BUILTIN_LINTERS.some((l) => LANGUAGE_OF[l] === lang),
);
