/**
 * The names the repo's name fences forbid, READ FROM DISK where a directory
 * already lists them — the same move `HARNESS_NAMES` makes over `src/adapters/`.
 *
 * Kept in its own module so the tests that bind each list to its source of
 * truth (`src/rules/index.test.ts`, `src/rules/groups.test.ts`) import the very
 * values `eslint.config.mjs` lints with, rather than a copy.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCS_RULES = fileURLToPath(new URL("../docs/rules/", import.meta.url));

/**
 * Every rule id: the basenames of `docs/rules/*.md`. `src/rules/index.test.ts`
 * holds this equal to `RULES.map((r) => r.id)`. When every rule is a module
 * (vigiles#390) the source flips to `src/rules/*.ts` basenames.
 */
export const RULE_IDS = readdirSync(DOCS_RULES)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -".md".length))
  .sort();

/**
 * Ids that are also plain English words. A string literal holding "coverage" or
 * "integrity" is a sentence at least as often as it is the rule, so the string
 * half leaves them to review.
 */
export const RULE_IDS_NOT_IN_STRINGS = ["coverage", "integrity"];

/**
 * Ids left out of the IDENTIFIER half: the one-word ids (an identifier segment
 * `coverage` is not the rule), and three older concept names that the code used
 * before they were rule ids — measured on 2026-10-14 at 47 (`hook-matcher`), 45
 * (`instruction-weight`) and 42 (`deprecated-key-files`) identifier hits, almost
 * all naming the concept, not the rule.
 */
export const RULE_IDS_NOT_IN_IDENTIFIERS = [
  "hook-matcher",
  "instruction-weight",
  "deprecated-key-files",
];

/** The ids the identifier half checks: multi-segment and not an older concept. */
export const RULE_IDS_IN_IDENTIFIERS = RULE_IDS.filter(
  (id) => id.includes("-") && !RULE_IDS_NOT_IN_IDENTIFIERS.includes(id),
);

/**
 * The rule GROUPS, as `local/no-group-names` takes them. `src/rules/groups.test.ts`
 * holds `[...GROUP_NAMES, ...GROUP_SET_NAMES]` equal to the keys of `RULE_GROUPS`.
 * `GROUP_SET_NAMES` are also ordinary words in this code base (a nudge is a
 * hint, a workflow is a GitHub Actions file), so only their group sense is
 * fenced — see `./no-group-names.mjs`.
 */
export const GROUP_NAMES = ["experimental", "structural"];
export const GROUP_SET_NAMES = ["workflow", "nudge"];
