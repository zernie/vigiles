/**
 * An ESLint check on vigiles' OWN source code. vigiles ships product rules
 * (`skill-resource-resolves`, `hook-events`, …) that it runs on users'
 * repositories; this check stops generic code — core, app, the CLI, tests —
 * from hardcoding the NAME of one of those product rules, so a rule's id lives
 * only in its own module `src/rules/<id>.ts`. Same idea as `no-harness-names`,
 * which stops generic code from writing a harness name. Registered as
 * `local/no-rule-ids`; it looks at strings and types everywhere, and at
 * identifiers in the generic contract files.
 *
 * A rule is a module, `src/rules/<id>.ts`, implementing core's `RuleSpec`;
 * `src/rules/index.ts` is the set; only a composition root hands the set to
 * core. The id is the rule's own name, so it is spelled in four places and no
 * fifth: the rule module, its colocated test, the set (`index.ts`, which still
 * holds the not-yet-migrated rules as rows), and `docs/rules/<id>.md`. A core,
 * app or root file that spells one has learned the name of an implementation —
 * mistake 1 or 4 in `.claude/skills/hexagonal-architecture/SKILL.md` — and the
 * next rule of the same kind will need an edit there too.
 *
 * Roots are NOT exempt, unlike the harness fence (where `init` legitimately
 * prints the harness it installs into): a root that wants one rule asks the set
 * by a property of the rule, never by its name. Tests are NOT exempt either
 * (owner decision, 14.10): a new test takes the id from the rule module
 * (`skillResourceResolves.id`) or uses a fixture rule.
 *
 * The names are read from `docs/rules/` (`./fence-names.mjs`), which the
 * rule-set test binds to `RULES` by an exact-set match, so a rule added with
 * its doc turns the fence on for its id with no edit here. Two ids are English
 * words (`coverage`, `integrity`) and are left out of the string half; one-word
 * and older concept names are left out of the identifier half — both lists,
 * with their reasons, are in `./fence-names.mjs`.
 *
 * The mechanism is `./no-foreign-names.mjs`, shared with `local/no-harness-names`.
 * Today's sites are grandfathered in `eslint-suppressions.json` (ESLint 10
 * refuses to let a file's count grow); reaching zero is vigiles#390.
 */
import { foreignNamesRule } from "./no-foreign-names.mjs";

export default foreignNamesRule({
  description:
    "Forbid a lint rule's id outside its own module in src/rules/, in value AND type positions.",
  messages: {
    hardcoded:
      'Generic code must not spell the rule id "{{name}}" ({{where}}). Read it off the ' +
      "RuleSpec you were handed or the injected rule set; the id belongs in " +
      "src/rules/{{name}}.ts (or, until it is migrated, its row in src/rules/index.ts).",
    literal:
      '"{{text}}" belongs to the rule {{name}} ({{where}}). Read it off the RuleSpec instead.',
  },
});
