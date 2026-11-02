/**
 * An ESLint check on vigiles' OWN source code: the generic half of rule-proof
 * (`src/core/rule-proof/*.ts` — the steps, the ports, the pair verdict) may not
 * spell the name of a linter kit (`"eslint"`, `ruffKit`, …). Registered as
 * `local/no-kit-names`.
 *
 * Rule-proof supports a linter through one module, `src/core/rule-proof/kits/<name>.ts`,
 * and one line in `kits/index.ts`. Generic code that branches on a kit's name
 * (`reading.linter === "eslint"`) or keeps its own table of kits makes the next
 * linter an edit in generic code — the shape the first draft of rule-proof had,
 * with 30 such spellings in its steps file. The names are read from the kits
 * directory in `eslint.config.mjs`, so a new kit is fenced the day it lands.
 *
 * Same engine as `no-harness-names` (`./no-foreign-names.mjs`): an AST rule over
 * literals, template parts and identifiers, so a comment that says "eslint" is
 * not a finding.
 */
import { foreignNamesRule } from "./no-foreign-names.mjs";

export default foreignNamesRule({
  description:
    "Forbid linter kit names in rule-proof's generic files, in value AND type positions.",
  messages: {
    hardcoded:
      'Generic rule-proof code must not spell the kit "{{name}}" ({{where}}). ' +
      "Put what this linter needs into its kit (src/core/rule-proof/kits/{{name}}.ts) " +
      "behind the ProofKit port, and read it off the kit at run time.",
    literal:
      '"{{text}}" belongs to the {{name}} kit ({{where}}). Read it from the kit instead.',
  },
});
