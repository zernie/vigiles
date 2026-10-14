/**
 * Directory-scoped guidance for working in `src/core/` (the harness-agnostic
 * detectors + domain).
 *
 * The full project rule set is the ROOT `CLAUDE.md` (compiled from
 * `CLAUDE.md.spec.ts`). This nested spec adds only the discipline that belongs
 * next to the detectors themselves — Claude Code loads it as directory memory
 * whenever you work in `src/core/`. Source of truth; `src/core/CLAUDE.md` is a
 * compiled build artifact (`vigiles compile`).
 */
import { instructionFile, guidance } from "./spec.js";

export default instructionFile({
  sections: {
    scope: `Working in \`src/core/\`? This is the harness-AGNOSTIC domain (spec, compile, linters, the lint/audit detectors). The root \`CLAUDE.md\` holds the full positioning + rule set — read it first. Two invariants live closest to this code: the core must not import an adapter (\`core ⊄ adapter\`, eslint-enforced) and must not hard-code a Claude Code literal (read it from the injected layout/dialect). This file adds the rule for ADDING or CHANGING a detector, and where the rule around it lives.`,
  },

  rules: {
    "detector-meta": guidance(
      "A deterministic DETECTOR here is a domain capability — a pure function shared by `lint` AND `audit`, never reimplemented per surface, reading the injected layout/dialect and never a Claude Code literal. The RULE around it — id, group, default, decidability bucket, cure, how a finding reads — is POLICY and lives in the outer rule layer: a module `src/rules/<id>.ts` (or, until it migrates in #390, its row in `src/rules/index.ts`), plus its `docs/rules/<id>.md`; `src/rules/index.test.ts` binds the set to the docs by an exact set match. Core declares the port (`./rule.ts`) and receives the set as a parameter (`configFor`, `applyRules`): never import `../rules`, never spell a rule id, never name a group — `boundaries`, `local/no-rule-ids` and `local/no-group-names` refuse each. The bucket is the CEILING, not a preference — a heuristic proxy (heuristic-behavioral) may NEVER default to `error` (it cries wolf); a structural-closed or external-decidable fact MAY, once proven FP-safe. Before writing a new detector, CLASSIFY the defect into a bucket — that decides whether it can ever gate. The model behind the buckets is the root `lint-rule-calibration` rule.",
    ),
  },
});
