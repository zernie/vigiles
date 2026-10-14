/**
 * Tests for the ESLint check that stops vigiles' own generic source code from
 * hardcoding the id of one of vigiles' product rules (`local/no-rule-ids`),
 * one case per POSITION a rule id can occupy — the same
 * enumeration `no-harness-names.test.ts` drives its suite from, because both
 * fences are `./no-foreign-names.mjs`. A violating snippet must fire and the
 * same shape reading the id off the rule it was handed must stay silent; an
 * uncovered position is then a missing ROW rather than a silent gap.
 */
import { RuleTester } from "eslint";
import tsparser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "./no-rule-ids.mjs";

RuleTester.describe = describe as never;
RuleTester.it = it as never;
RuleTester.itOnly = it.only as never;

const tester = new RuleTester({
  languageOptions: {
    parser: tsparser as never,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

/**
 * Stated, not read from `docs/rules/`: a RuleTester case must be able to fail
 * for a reason other than "somebody added a rule". `eslint.config.mjs` reads
 * the real list (`./fence-names.mjs`).
 */
const NAMES = ["skill-resource-resolves", "hook-events"];
const BOTH_HALVES = [{ names: NAMES, identifiers: true }];

interface Position {
  readonly id: string;
  readonly bad: string;
  readonly good: string;
  readonly errors: number;
}

const POSITIONS: readonly Position[] = [
  {
    id: "value-comparison",
    bad: 'const on = spec.id === "skill-resource-resolves";',
    good: "const on = spec.id === wanted.id;",
    errors: 1,
  },
  {
    id: "severity-lookup",
    bad: 'const sev = rules.severityAt("hook-events", path);',
    good: "const sev = rules.severityAt(spec.id, path);",
    errors: 1,
  },
  {
    id: "object-key",
    bad: 'const d = { "hook-events": severity.default("warn") };',
    good: "const d = Object.fromEntries(rules.map((r) => [r.id, r.defaultSeverity]));",
    errors: 1,
  },
  {
    id: "element-access",
    bad: 'const f = report.experimental["skill-resource-resolves"];',
    good: "const f = report.findings.get(spec.id);",
    errors: 1,
  },
  {
    id: "type-union",
    bad: 'type Ids = "hook-events" | "skill-resource-resolves";',
    good: 'type Ids = (typeof RULES)[number]["id"];',
    errors: 2,
  },
  {
    id: "type-mapped-key",
    bad: 'type M = { readonly [K in "hook-events"]: number };',
    good: "type M = { readonly [K in RuleId]: number };",
    errors: 1,
  },
  {
    id: "type-property-signature",
    bad: 'interface R { readonly rule: "skill-resource-resolves" }',
    good: "interface R { readonly rule: string }",
    errors: 1,
  },
  {
    id: "template-literal",
    bad: "const msg = `hook-events: ${n}`;",
    good: "const msg = `${spec.id}: ${n}`;",
    errors: 1,
  },
  {
    id: "identifier-camel-case",
    bad: "const n = skillResourceResolvesCount;",
    good: "const n = findingCount;",
    errors: 1,
  },
  {
    id: "identifier-type-name",
    bad: "type X = HookEventsFinding;",
    good: "type X = Finding;",
    errors: 1,
  },
];

tester.run("no-rule-ids (positions)", rule as never, {
  valid: [
    ...POSITIONS.map((p) => ({
      name: `${p.id}: reading the id off the rule is accepted`,
      code: p.good,
      options: BOTH_HALVES,
    })),
    {
      name: "prose: a comment naming hook-events is not code",
      code: "// hook-events is documented in docs/rules/hook-events.md\nconst x = 1;",
      options: BOTH_HALVES,
    },
    {
      name: "a rule module spells its OWN id (the config drops it from names)",
      code: 'export const hookEvents = defineRule({ id: "hook-events" });',
      options: [{ names: ["skill-resource-resolves"], identifiers: true }],
    },
    {
      name: "tokens, not substrings: a longer word is not the id",
      code: 'const s = "hook-eventsx";',
      options: BOTH_HALVES,
    },
  ],
  invalid: POSITIONS.map((p) => ({
    name: `${p.id}: a spelled rule id is reported`,
    code: p.bad,
    options: BOTH_HALVES,
    errors: p.errors,
  })),
});

tester.run("no-rule-ids (identifier half as a list)", rule as never, {
  valid: [
    {
      name: "an id outside the identifier list is not reported as an identifier",
      code: "const n = hookEventsCount;",
      options: [{ names: NAMES, identifiers: ["skill-resource-resolves"] }],
    },
    {
      name: "identifiers off: the string half alone",
      code: "const n = skillResourceResolvesCount;",
      options: [{ names: NAMES }],
    },
  ],
  invalid: [
    {
      name: "an id in the identifier list is reported as an identifier",
      code: "const n = skillResourceResolvesCount;",
      options: [{ names: NAMES, identifiers: ["skill-resource-resolves"] }],
      errors: [
        {
          messageId: "hardcoded",
          data: { name: "skill-resource-resolves", where: "an identifier" },
        },
      ],
    },
    {
      name: "the string half stays on whatever the identifier list holds",
      code: 'const on = r === "hook-events";',
      options: [{ names: NAMES, identifiers: [] }],
      errors: 1,
    },
  ],
});
