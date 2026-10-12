/**
 * A rule that is ON by default must not be curable only through an experimental
 * API (#362). `hand-written-hook` taught this: its only cure is a compiled hook,
 * written with `experimental_define*`, and as a default-on rule it would have
 * pushed every user onto an unstable API.
 *
 * "Experimental" is read from the name: `local/experimental-name`
 * (eslint-rules/experimental-name.mjs) holds every `@experimental` export to the
 * `experimental_` prefix and every prefixed export to the tag, so the name IS
 * the registry — there is no second list here. The cure must also be a real
 * public export, so a renamed API cannot leave a stale cure behind.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { RULE_META, allRuleMeta } from "./core/rule-meta.js";
import { DEFAULT_RULES } from "./core/validate.js";
import { RECOMMENDED_RULES } from "./core/presets.js";
import * as hookApi from "./hook.js";
import * as specApi from "./core/spec.js";
import * as testApi from "./test.js";

/** Every public value export a cure may name. */
const PUBLIC_EXPORTS: ReadonlySet<string> = new Set([
  ...Object.keys(hookApi),
  ...Object.keys(specApi),
  ...Object.keys(testApi),
]);

/** On by default: in the preset, or a base default other than off. */
function onByDefault(id: string): boolean {
  const base: unknown = Object.entries(DEFAULT_RULES).find(
    ([k]) => k === id,
  )?.[1];
  const recommended: readonly string[] = RECOMMENDED_RULES;
  return recommended.includes(id) || (base !== false && base !== undefined);
}

test("every rule names its cure, and a named export exists", () => {
  for (const meta of allRuleMeta()) {
    assert.ok(meta.cure !== undefined, `${meta.id}: no cure`);
    if (typeof meta.cure === "object" && "export" in meta.cure)
      assert.ok(
        PUBLIC_EXPORTS.has(meta.cure.export),
        `${meta.id}: cure ${meta.cure.export} is not a public export`,
      );
  }
});

test("no rule that is on by default is cured only by an experimental export", () => {
  const offending = allRuleMeta()
    .filter((m) => onByDefault(m.id))
    .filter(
      (m) =>
        typeof m.cure === "object" &&
        "export" in m.cure &&
        m.cure.export.startsWith("experimental_"),
    )
    .map((m) => `${m.id} (cure: ${JSON.stringify(m.cure)})`);
  assert.deepEqual(offending, []);
  // The rule that taught it stays off until its cure leaves experimental.
  assert.deepEqual(RULE_META["hand-written-hook"].cure, {
    export: "experimental_defineHook",
  });
});
