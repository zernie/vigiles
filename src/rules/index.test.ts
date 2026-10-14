/**
 * The rule SET (`./index.ts`) — what the old `core/rule-meta.test.ts` held,
 * moved beside the set it checks, plus the pins this PR's move needs:
 *
 * - the set is ONE thing: every rule has a doc, a row in the canonical matrix
 *   and a known group, and the docs have no rule the set lacks;
 * - each rule's declared default is what `{}` parses to, and the bucket is the
 *   ceiling (a heuristic rule never defaults to `error`);
 * - moving the rules out of core changed NO rule's effective severity, under
 *   `{}` or `{"extends": "vigiles:recommended"}`, against a snapshot of
 *   `main` (`test/fixtures/effective-severities.main.json`) — except an
 *   ungraded group's rule, which is now off;
 * - a rule on by default is never curable only through an `experimental_`
 *   export (#362).
 *
 * No rule id is spelled here (`local/no-rule-ids`): every id comes off the
 * set or out of a fixture file.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { configFor } from "../core/config-schema.js";
import { configDefault, initPolicyOf } from "../core/rule.js";
import { EXPERIMENTAL_RULES } from "../core/rule-meta.js";
import * as hookApi from "../hook.js";
import * as specApi from "../core/spec.js";
import * as testApi from "../test.js";
import { RULES, RULE_GROUPS } from "./index.js";

const REPO = join(__dirname, "..", "..");
const RULES_DOC_DIR = join(REPO, "docs", "rules");
const RULES_MATRIX = join(REPO, "docs", "verifying-instruction-files.md");
const CONFIG = configFor(RULES, RULE_GROUPS);
const IDS: readonly string[] = RULES.map((r) => r.id);

/** A parsed config's rules, or the test fails with the schema's message. */
function parsedRules(raw: unknown): Readonly<Record<string, unknown>> {
  const r = CONFIG.parse(raw);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data.rules;
}

/** `"warn" | "error" | false` of an entry, options dropped. */
const severityOf = (entry: unknown): unknown =>
  Array.isArray(entry) ? entry[0] : entry;

describe("the rule set is one thing", () => {
  it("every documented rule is in the set, and every rule is documented", () => {
    const docs = readdirSync(RULES_DOC_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect([...IDS].sort()).toEqual(docs);
  });

  // 🔴 The set was already bound to `docs/rules/*.md`, and that pair still let
  // TWO rules sit outside the canonical matrix for as long as they existed: each
  // had a meta AND a doc, so the set-equality above passed, while the ONE list a
  // reader consults never named them. Matched on a TABLE ROW, not on "appears in
  // the file", so a name in the page's prose does not count as documented.
  it("every rule has a ROW in the canonical matrix", () => {
    const matrix = readFileSync(RULES_MATRIX, "utf8");
    const linked = new Set(
      [
        ...matrix.matchAll(/^\|\s*\[`[^`]+`\]\(rules\/([a-z0-9-]+)\.md\)/gm),
      ].map((m) => m[1]),
    );
    expect(IDS.filter((id) => !linked.has(id))).toEqual([]);
  });

  it("ids are unique", () => {
    expect(new Set(IDS).size).toBe(IDS.length);
  });

  it("every rule is in exactly one group, and every group is a known one", () => {
    const groups = new Set(Object.keys(RULE_GROUPS));
    for (const rule of RULES)
      expect(groups.has(rule.group), `${rule.id} group`).toBe(true);
  });

  it("every group holds at least one rule", () => {
    const used = new Set<string>(RULES.map((r) => r.group));
    expect(Object.keys(RULE_GROUPS).filter((g) => !used.has(g))).toEqual([]);
  });
});

describe("each rule's declaration", () => {
  it("its declared default is what an empty config parses to", () => {
    const rules = parsedRules({});
    for (const rule of RULES)
      expect(severityOf(rules[rule.id]), `${rule.id} default`).toBe(
        configDefault(rule),
      );
  });

  it("an empty config parses to every rule in the set, in the set's order", () => {
    expect(Object.keys(parsedRules({}))).toEqual(IDS);
    expect(CONFIG.ruleNames).toEqual(IDS);
  });

  it("has a non-empty surface, summary and detector", () => {
    for (const rule of RULES) {
      expect(rule.surface.length, `${rule.id} surface`).toBeGreaterThan(0);
      expect(rule.summary.length, `${rule.id} summary`).toBeGreaterThan(0);
      expect(rule.detector.length, `${rule.id} detector`).toBeGreaterThan(0);
    }
  });

  it("a heuristic-behavioral rule never claims a hard (error) default — that would cry wolf", () => {
    for (const rule of RULES)
      if (rule.bucket === "heuristic-behavioral")
        expect(rule.defaultSeverity, rule.id).not.toBe("error");
  });
});

describe("moving the rules out of core moved no severity", () => {
  const snapshot = z
    .record(z.string(), z.unknown())
    .transform((o) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_"))),
    )
    .pipe(z.record(z.string(), z.record(z.string(), z.unknown())))
    .parse(
      JSON.parse(
        readFileSync(
          join(REPO, "test", "fixtures", "effective-severities.main.json"),
          "utf8",
        ),
      ),
    );
  const ungraded = new Set<string>(
    RULES.filter((r) => !RULE_GROUPS[r.group].graded).map((r) => r.id),
  );

  it.each(Object.keys(snapshot))(
    "under %s every rule has main's effective severity (an ungraded group's rule is off)",
    (config) => {
      const rules = parsedRules(JSON.parse(config));
      const expected = snapshot[config] ?? {};
      expect(Object.keys(expected).sort()).toEqual([...IDS].sort());
      for (const id of IDS)
        expect(severityOf(rules[id]), id).toBe(
          ungraded.has(id) ? false : expected[id],
        );
    },
  );
});

describe("presets and init derive from the groups", () => {
  it("a preset raises only its own group's rules, at the group's severity", () => {
    for (const [name, group] of Object.entries(RULE_GROUPS)) {
      if (!("preset" in group)) continue;
      const rules = parsedRules({ extends: group.preset.name });
      for (const rule of RULES)
        if (rule.group === name)
          expect(severityOf(rules[rule.id]), rule.id).toBe(
            group.preset.severity,
          );
    }
  });

  it("an ungraded group's preset never sets error", () => {
    for (const group of Object.values(RULE_GROUPS))
      if (!group.graded && "preset" in group)
        expect(group.preset.severity).toBe("warn");
  });

  it("init writes the preset of the one group marked for it", () => {
    const marked = Object.values(RULE_GROUPS).filter(
      (g) => "init" in g && g.init === "extends",
    );
    expect(marked).toHaveLength(1);
    expect(initPolicyOf(RULES, RULE_GROUPS).preset).toMatch(/^vigiles:/);
  });

  it("init --strict never writes an opt-in (off by default) rule", () => {
    const strict = new Set<string>(
      initPolicyOf(RULES, RULE_GROUPS).strictRules,
    );
    for (const rule of RULES)
      if (strict.has(rule.id))
        expect(rule.defaultSeverity, rule.id).not.toBe("off");
  });

  // TRANSITIONAL: the old experimental list survives in `core/rule-meta.ts`
  // until the experimental block is rendered from the group record; it must
  // say exactly what the group says until then.
  it("the transitional experimental list equals the ungraded groups' rules", () => {
    expect([...EXPERIMENTAL_RULES].sort()).toEqual(
      RULES.filter((r) => !RULE_GROUPS[r.group].graded)
        .map((r) => r.id)
        .sort(),
    );
  });
});

describe("a rule's cure", () => {
  /** Every public value export a cure may name. */
  const PUBLIC_EXPORTS: ReadonlySet<string> = new Set([
    ...Object.keys(hookApi),
    ...Object.keys(specApi),
    ...Object.keys(testApi),
  ]);
  const recommended = parsedRules({
    extends: initPolicyOf(RULES, RULE_GROUPS).preset,
  });

  it("every rule names its cure, and a named export exists", () => {
    for (const rule of RULES)
      if (typeof rule.cure === "object" && "export" in rule.cure)
        expect(PUBLIC_EXPORTS.has(rule.cure.export), rule.id).toBe(true);
  });

  // A rule that is ON by default must not be curable only through an
  // experimental API (#362): the rule that taught it, whose only cure is a
  // compiled hook written with `experimental_define*`, would have pushed every
  // user onto an unstable API. "Experimental" is read from the export's name —
  // `local/experimental-name` holds every `@experimental` export to the prefix.
  it("no rule that is on by default — or under the recommended preset — is cured only by an experimental export", () => {
    const offending = RULES.filter(
      (r) => configDefault(r) !== false || recommended[r.id] !== false,
    ).filter(
      (r) =>
        typeof r.cure === "object" &&
        "export" in r.cure &&
        r.cure.export.startsWith("experimental_"),
    );
    expect(offending.map((r) => r.id)).toEqual([]);
    expect(
      RULES.some(
        (r) =>
          typeof r.cure === "object" &&
          "export" in r.cure &&
          r.cure.export === "experimental_defineHook",
      ),
      "the rule that taught it stays in the set, off",
    ).toBe(true);
  });
});
