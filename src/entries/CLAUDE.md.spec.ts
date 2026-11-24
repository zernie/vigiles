/**
 * Directory-scoped guidance for working in `src/entries/` (the package entries).
 *
 * The full project rule set is the ROOT `CLAUDE.md` (compiled from
 * `CLAUDE.md.spec.ts`). This nested spec adds only the namespace discipline that
 * belongs next to the entry modules — Claude Code loads it as directory memory
 * whenever you work in `src/entries/`. Source of truth; `src/entries/CLAUDE.md`
 * is a compiled build artifact (`vigiles compile`).
 */
import { instructionFile, guidance, file, prose } from "../core/spec.js";

const RULES = file("docs/contributing/rules.md");

export default instructionFile({
  sections: {
    scope: prose`Working in \`src/entries/\`? An ENTRY is one row of ${file("package.json")} \`exports\` plus its module here, which only re-exports (the matcher entries \`vigiles/vitest\` and \`vigiles/jest\` are the exception: they register side effects, so their modules stay in \`src/\`). The module mirrors the export path: \`vigiles/hook/testing\` is \`src/entries/hook/testing.ts\`, \`vigiles\` itself is \`src/entries/index.ts\`. Entries are composition roots, so they may import an adapter. The root \`CLAUDE.md\` holds the full rule set — read it first; this file adds only the namespace rules.`,
  },

  rules: {
    "one-audience-per-entry": guidance(
      "Each entry serves ONE audience, and each public name lives in exactly ONE entry (gate: one name, one entry, `scripts/export-gates.test.ts`).",
      { details: RULES, anchor: "public-exports-are-opt-in" },
    ),

    "two-levels-only": guidance(
      'At most two path levels, and only for a family (`harness/*`, which grows with each harness) or for "X and its tests" (`hook/testing`, the `@angular/core/testing` convention). Everything else stays flat; there is no third level.',
    ),

    "name-reads-to-an-outsider": guidance(
      "An entry's name must read clearly to someone who has never seen this repo: no internal jargon (the word battery was dropped from the name of `vigiles/hook/testing` for this reason). Decide the name before the entry has users.",
    ),

    "hook-entry-stays-effect-free": guidance(
      "`vigiles/hook` stays effect-free: it is the only import a compiled hook may have, and `src/hook-entry-effects.test.ts` holds that. Test or loader helpers never go there; they belong in `vigiles/hook/testing`.",
    ),

    "a-new-entry-passes-the-gates": guidance(
      "A new entry passes the gates: a release tag on every export, a `STABILITY.md` row, a budget row in `api-surface/budget.json` with an empty grandfather list, and a row in the `ENTRIES` list of `scripts/api-extractor.mjs` (with its report in `api-surface/`).",
      { details: RULES, anchor: "public-exports-are-opt-in" },
    ),

    "renaming-an-entry-is-breaking": guidance(
      "Renaming or moving an entry is a BREAKING release (`feat!:` with a `BREAKING CHANGE:` footer listing old → new paths, plus a row in the migration table of `docs/testing-api.md`); aliases are not kept.",
    ),
  },
});
