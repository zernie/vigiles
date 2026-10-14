/**
 * The fence name lists (`./fence-names.mjs`) against what they stand for. The
 * lint config cannot import TypeScript, so the group names are written there
 * and this test binds them to the group record — the same move
 * `adapter-contract.test.ts` makes for the adapter directory names
 * `local/no-harness-names` reads. The rule ids are read from `docs/rules/`,
 * which `src/rules/index.test.ts` binds to the rule set.
 */
import { expect, it } from "vitest";

import {
  GROUP_NAMES,
  GROUP_SET_NAMES,
  RULE_IDS,
  RULE_IDS_IN_IDENTIFIERS,
  RULE_IDS_NOT_IN_STRINGS,
} from "./fence-names.mjs";
import { RULE_GROUPS } from "../src/rules/groups.js";
import { RULES } from "../src/rules/index.js";

it("the group-name fence lists exactly the groups", () => {
  expect([...GROUP_NAMES, ...GROUP_SET_NAMES].sort()).toEqual(
    Object.keys(RULE_GROUPS).sort(),
  );
});

it("the rule-id fence reads exactly the rule set's ids", () => {
  expect(RULE_IDS).toEqual(RULES.map((r) => r.id).sort());
});

it("every exclusion names a real rule id", () => {
  for (const id of [...RULE_IDS_NOT_IN_STRINGS, ...RULE_IDS_IN_IDENTIFIERS])
    expect(RULE_IDS).toContain(id);
});
