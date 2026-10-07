/**
 * The config SCHEMA and its messages (`src/core/config-schema.ts`).
 *
 * Two things are under test and they fail differently, so they are asserted
 * apart. The SHAPE decides what is accepted — every case here carries the
 * accepted spelling beside the rejected one, because a schema that rejects
 * everything and a schema that rejects the right thing look identical from the
 * failing side. The MESSAGES decide whether a rejection is usable, and they are
 * asserted on their exact text: the bar this replaced is a real line that was
 * already good (`✗ Unknown harness "claud-code". Known: claude-code, codex.`),
 * and a schema library's default output is worse than it on both counts — no
 * candidate list, and one line per union branch. Asserting the wording is how a
 * regression back to the library default is caught.
 *
 * Model-free, IO-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  vigilesConfigSchema,
  formatConfigIssues,
  parseVigilesConfig,
} from "./config-schema.js";
import { RECOMMENDED_RULES } from "./presets.js";

/** The formatted problems for a config, or `[]` when it parses. */
function problems(config: unknown): string[] {
  const r = vigilesConfigSchema.safeParse(config);
  return r.success ? [] : formatConfigIssues(r.error.issues);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("the new harness shape parses, with and without roots", () => {
  assert.deepEqual(
    vigilesConfigSchema.parse({
      harnesses: { "claude-code": { roots: [".ai"] }, codex: {} },
    }).harnesses,
    { "claude-code": { roots: [".ai"] }, codex: {} },
  );
});

/**
 * 🔴 THE KEY ORDER IS PRESERVED, and something depends on it: the first key is
 * the PRIMARY harness, the one whose dialect the report is rendered in. JS
 * preserves string-key insertion order, and this pins it rather than trusting a
 * language guarantee nobody re-reads.
 */
test("declaration order survives parsing", () => {
  const parsed = vigilesConfigSchema.parse({
    harnesses: { codex: {}, "claude-code": { roots: [".ai"] } },
  });
  assert.deepEqual(Object.keys(parsed.harnesses ?? {}), [
    "codex",
    "claude-code",
  ]);
});

test("an unknown key inside a harness declaration is refused", () => {
  // The accepted spelling first, so this cannot pass by refusing everything.
  assert.deepEqual(problems({ harnesses: { codex: { roots: [".ai"] } } }), []);
  assert.deepEqual(problems({ harnesses: { codex: { root: ".ai" } } }), [
    '.vigilesrc.json: unknown key "root" in harnesses.codex. Did you mean "roots"?',
  ]);
});

/**
 * 🔴 `$schema` IS ACCEPTED, AND STRICTNESS IS STILL ON — the two halves of one
 * fix, asserted together because either alone is a different bug.
 *
 * The first half is the defect: the tool publishes `dist/vigilesrc.schema.json`
 * for editors, whose own `$id` is the unpkg URL a reader pastes, and the
 * documented way to point a document at a JSON Schema — a `"$schema"` key —
 * exited 2 with `unknown key "$schema"`. The second half is what stops the fix
 * from being "turn strictness off": a key that really is unknown must still be
 * refused, with its message intact.
 */
test("$schema is accepted and ignored, while a genuinely unknown key still fails", () => {
  const withPointer = {
    $schema: "https://unpkg.com/vigiles/dist/vigilesrc.schema.json",
    harnesses: { "claude-code": { roots: [".ai"] } },
  };
  assert.deepEqual(problems(withPointer), []);
  // Accepted, not acted on: the rest parses exactly as it would without it.
  assert.deepEqual(vigilesConfigSchema.parse(withPointer).harnesses, {
    "claude-code": { roots: [".ai"] },
  });

  // The other half. A neighbouring `$`-prefixed key is NOT excused, and neither
  // is an ordinary typo — strictness is intact, exactly one key wider.
  assert.deepEqual(problems({ $schemas: "x" }), [
    '.vigilesrc.json: unknown key "$schemas" in (top level). Did you mean "$schema"?',
  ]);
  assert.deepEqual(problems({ harnessez: {} }), [
    '.vigilesrc.json: unknown key "harnessez" in (top level). Did you mean "harnesses"?',
  ]);
});

/**
 * The candidate list is derived from the schema's shape, so adding a key to the
 * shape edits every "Known: …" message. `$schema` is declared LAST for exactly
 * that reason — it lands past the display cap, so a misspelling of a real key
 * still gets the same twelve names it got before.
 */
test("declaring $schema does not push a real candidate out of the suggestion list", () => {
  const far = problems({ zzzzzzzzzzzz: 1 });
  assert.equal(far.length, 1);
  assert.match(far[0], /Known: ruleMarkers, rules, files/);
  assert.doesNotMatch(far[0], /\$schema/);
});

/**
 * ⚠️ THE HARNESS NAME IS NOT CHECKED HERE, and that is deliberate rather than a
 * gap. `resolveDeclaredHarnesses` resolves the key against the adapter registry
 * and throws the existing `Unknown harness "claud-code". Known: …` — a message
 * this schema cannot produce without `core/` importing the registry, which the
 * `core-not-adapter` boundary forbids. Two places deciding what an unknown
 * harness name means is how the two wordings would drift.
 */
test("an unknown harness NAME passes the schema — the registry owns that", () => {
  assert.deepEqual(problems({ harnesses: { "claud-code": {} } }), []);
});

test("a bare string is a one-element list, not a string spread char-by-char", () => {
  assert.deepEqual(
    vigilesConfigSchema.parse({ harnesses: { codex: { roots: ".ai" } } })
      .harnesses?.codex.roots,
    [".ai"],
  );
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * 🔴 A NEAR-MISS REPLACES THE CANDIDATE LIST RATHER THAN JOINING IT.
 *
 * `rules` has 32 keys. Printing all of them beside `Did you mean "spec-refs"?`
 * buries the one line that is the answer, so the suggestion wins when there is
 * one — and the list is printed only when there is not, which is the case where
 * the list IS the answer.
 */
test("an unknown key suggests the near-miss instead of listing 34 candidates", () => {
  assert.deepEqual(problems({ rules: { "spec-ref": "error" } }), [
    '.vigilesrc.json: unknown key "spec-ref" in rules. Did you mean "spec-refs"?',
  ]);
  const far = problems({ rules: { zzzzzzzzzzzz: "warn" } });
  assert.equal(far.length, 1);
  assert.doesNotMatch(far[0], /Did you mean/);
  assert.match(far[0], /Known: spec-refs, orphan-docs/);
  // Capped, with the remainder COUNTED rather than dropped — a silently short
  // list would read as "these are all of them".
  assert.match(far[0], /… and 22 more\.$/);
});

test("an unknown top-level key names the near-miss", () => {
  assert.deepEqual(problems({ harnessez: {} }), [
    '.vigilesrc.json: unknown key "harnessez" in (top level). Did you mean "harnesses"?',
  ]);
});

/**
 * 🔴 ONE LINE PER PROBLEM, not one per union branch.
 *
 * Zod reports a failed union as eight nested branch errors — "expected
 * \"warn\"", "expected 0", "expected 1", … — which is the schema explaining its
 * own internals. What a reader needs is the set of things the key takes.
 */
test("a bad value collapses the union cascade into one line", () => {
  assert.deepEqual(problems({ rules: { integrity: "errr" } }), [
    ".vigilesrc.json: rules.integrity is not one of the accepted values " +
      '("warn", "error", false, "off", 0, 1, 2, true).',
  ]);
});

test("two problems are two lines, neither hiding the other", () => {
  assert.deepEqual(problems({ harnessez: {}, bundels: "all" }), [
    '.vigilesrc.json: unknown key "harnessez" in (top level). Did you mean "harnesses"?',
    '.vigilesrc.json: unknown key "bundels" in (top level). Did you mean "bundles"?',
  ]);
});

test("a wrong TYPE says what was expected and what arrived", () => {
  assert.deepEqual(problems({ harnesses: ["claude-code"] }), [
    ".vigilesrc.json: harnesses — Invalid input: expected record, received array.",
  ]);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Parsing `{}` IS the default config — that identity is what lets the TS type be
 * `z.infer` of this schema rather than a hand-written twin. If the schema and
 * the shipped defaults ever disagree, `rule-meta.test.ts` (which reads
 * `DEFAULT_RULES`, now derived from here) is the second place it shows.
 */
test("an empty config parses to the shipped defaults", () => {
  const d = vigilesConfigSchema.parse({});
  assert.deepEqual(d.files, ["CLAUDE.md"]);
  assert.deepEqual(d.ruleMarkers, ["headings", "checkboxes"]);
  assert.equal(d.rules["spec-refs"], "error");
  assert.equal(d.rules["doc-refs"], false);
  assert.equal(d.rules["prefer-compiled-hooks"], false);
  assert.equal(d.rules.integrity, "warn");
  assert.equal(Object.keys(d.rules).length, 34);
  assert.equal(d.harnesses, undefined, "no declaration means auto-detect");
});

// ---------------------------------------------------------------------------
// Presets — `"extends": "vigiles:recommended"` (the ESLint model)
// ---------------------------------------------------------------------------

/**
 * WHY A PRESET AND NOT NINE WRITTEN LINES. `init` used to make the structural
 * rules gate by WRITING each one at `error` into a new repo's config, because
 * every rule's built-in default is `warn`. A repo set up before a rule joined
 * that group therefore never got it from an upgrade: the nine lines were a
 * snapshot of the group on the day `init` ran (#338). A preset is read at load
 * time, so a repo that extends it follows the group as vigiles ships it.
 */
test("extends vigiles:recommended raises exactly the preset's rules to error", () => {
  const r = parseVigilesConfig({ extends: "vigiles:recommended" });
  assert.ok(r.success, "the preset name parses");
  for (const name of RECOMMENDED_RULES) {
    assert.equal(r.data.rules[name], "error", `${name} is gated by the preset`);
  }
  // A rule outside the preset keeps its built-in default.
  assert.equal(r.data.rules["unmarked-refs"], "warn");
  assert.equal(r.data.rules["doc-refs"], false);
  assert.equal(r.data.extends, "vigiles:recommended");
});

test("an explicit rules entry overrides the preset, in both directions", () => {
  const r = parseVigilesConfig({
    extends: "vigiles:recommended",
    rules: { "hook-events": "warn", "description-overlap": "off" },
  });
  assert.ok(r.success);
  assert.equal(r.data.rules["hook-events"], "warn", "downgraded by the user");
  assert.equal(r.data.rules["description-overlap"], false, "turned off");
  assert.equal(r.data.rules["hook-script-exists"], "error", "rest stays gated");
});

test("without extends, no rule moves off its built-in default", () => {
  const r = parseVigilesConfig({});
  assert.ok(r.success);
  for (const name of RECOMMENDED_RULES) {
    assert.equal(r.data.rules[name], "warn", `${name} default is unchanged`);
  }
});

test("an unknown preset name is refused, naming the one that exists", () => {
  const r = parseVigilesConfig({ extends: "vigiles:recomended" });
  assert.ok(!r.success);
  assert.deepEqual(formatConfigIssues(r.error.issues), [
    '.vigilesrc.json: extends — Invalid input: expected "vigiles:recommended".',
  ]);
});

test("a bad rule value under a preset is still the rule's own error", () => {
  const r = parseVigilesConfig({
    extends: "vigiles:recommended",
    rules: { "hook-events": "errr" },
  });
  assert.ok(!r.success);
  assert.match(
    formatConfigIssues(r.error.issues)[0] ?? "",
    /rules\.hook-events/,
  );
});
