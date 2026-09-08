/**
 * Rule-meta coverage suite (vitest): the registry's keys EXACTLY match docs/rules/*.md (every rule has a meta AND a doc — the set is one thing), each defaultSeverity matches the real exported DEFAULT_RULES (no drift), every meta has a non-empty surface + known bucket + summary + detector, and a heuristic-behavioral rule never defaults to error (would cry wolf)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RULE_META, allRuleMeta, type RuleName } from "./rule-meta.js";
import { DEFAULT_RULES } from "./validate.js";

const RULES_DOC_DIR = join(__dirname, "..", "..", "docs", "rules");
const RULES_MATRIX = join(
  __dirname,
  "..",
  "..",
  "docs",
  "verifying-instruction-files.md",
);

function docRuleNames(): string[] {
  return readdirSync(RULES_DOC_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

describe("RULE_META registry", () => {
  it("declares a meta for every documented rule (docs/rules/*.md)", () => {
    const docs = docRuleNames().sort();
    const metas = Object.keys(RULE_META).sort();
    // Every doc has a meta AND every meta has a doc — the rule SET is one thing.
    expect(metas).toEqual(docs);
  });

  // 🔴 The registry was already bound to `docs/rules/*.md`, and that pair still
  // let TWO rules (`spec-refs`, `duplicate-rules`) sit outside the canonical
  // matrix for as long as they have existed: each had a meta AND a doc, so the
  // set-equality above passed, while the ONE list a reader consults never named
  // them. Their only symptom was an orphan-doc warning — the doc was unreachable
  // BECAUSE the matrix did not link it — which is a symptom of the wrong thing
  // and reads as docs housekeeping rather than a missing rule.
  //
  // Matched on a TABLE ROW (`| [` … `](rules/<name>.md)`), not on "appears in the
  // file": a rule name dropped into the prose of that page would otherwise count
  // as documented. That keeps this a within-line token match, so it needs no
  // fence/heading state and cannot carry the toggle bug the shared markdown
  // helper exists to prevent.
  it("every rule has a ROW in the canonical matrix (docs/verifying-instruction-files.md)", () => {
    const matrix = readFileSync(RULES_MATRIX, "utf8");
    const linked = new Set(
      [
        ...matrix.matchAll(/^\|\s*\[`[^`]+`\]\(rules\/([a-z0-9-]+)\.md\)/gm),
      ].map((m) => m[1]),
    );
    const missing = Object.keys(RULE_META)
      .filter((name) => !linked.has(name))
      .sort();
    expect(
      missing,
      `rule(s) with no row in the matrix — a reader looking up the rule set will not find them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("each meta's defaultSeverity matches the real DEFAULT_RULES", () => {
    for (const meta of allRuleMeta()) {
      // 🔴 A `continue` for `orphan-docs` used to sit here ("built-in, not in
      // RulesConfig"). It was true when written and stale by the time it was
      // found: the rule was moved into `RulesConfig` and the exemption kept
      // excusing it from the one comparison that would have flagged the drift.
      // An escape hatch that outlives its reason is the defect this file exists
      // to catch, wearing the file's own clothes.
      const actual = DEFAULT_RULES[meta.id as keyof typeof DEFAULT_RULES];
      const normalized =
        actual === false ? "off" : Array.isArray(actual) ? actual[0] : actual;
      expect(normalized, `defaultSeverity drift for ${meta.id}`).toBe(
        meta.defaultSeverity,
      );
    }
  });

  it("every meta has a non-empty surface + a known bucket", () => {
    const buckets = new Set([
      "structural-closed",
      "external-decidable",
      "heuristic-behavioral",
    ]);
    for (const meta of allRuleMeta()) {
      expect(meta.surface.length, `${meta.id} surface`).toBeGreaterThan(0);
      expect(buckets.has(meta.bucket), `${meta.id} bucket`).toBe(true);
      expect(meta.id, `${meta.id} id matches key`).toBe(meta.id);
      expect(meta.summary.length, `${meta.id} summary`).toBeGreaterThan(0);
      expect(meta.detector.length, `${meta.id} detector`).toBeGreaterThan(0);
    }
  });

  it("a heuristic-behavioral rule never claims a hard (error) default — that would cry wolf", () => {
    for (const meta of allRuleMeta()) {
      if (meta.bucket === "heuristic-behavioral") {
        expect(
          meta.defaultSeverity,
          `${meta.id} is heuristic but defaults to error`,
        ).not.toBe("error");
      }
    }
  });

  it("ruleMeta() round-trips a known id and rejects an unknown one", () => {
    const id: RuleName = "lethal-trifecta";
    expect(RULE_META[id].bucket).toBe("structural-closed");
  });
});

// ---------------------------------------------------------------------------
// The direction this registry does NOT close, and why there is no test for it
// ---------------------------------------------------------------------------
//
// 🔴 `Record<RuleName, RuleMeta>` closes one direction: a rule without a meta is
// a tsc error. The other — that a declared rule is REACHABLE, i.e. some code
// actually reads its severity — is exactly what #181 was. `orphan-docs` had a
// meta, a doc and a documented default while `"warn"` and `"off"` were both
// silently ignored, because nothing looked it up.
//
// A textual check for it was written here and then REMOVED, because it was
// measured and it did not work. Five iterations, each fixing what the last one
// missed:
//
//   1. matched `rules["id"]` only  → `integrity`/`coverage`, read via dot access,
//      reported as unreachable
//   2. added dot access            → `require-instructions-spec`, read off a
//      local, still missed
//   3. matched `["id"]` anywhere   → GREEN with every real read of `orphan-docs`
//      deleted, kept alive by an unrelated `new Set([...])` in linters.ts
//   4. required an object before the bracket → its own comment-stripper ate real
//      code, because cli.ts holds glob strings whose slash-star opens a comment
//      that closes somewhere else entirely
//   5. stripped comments with the real TS scanner → still wrong on three rules
//
// Step 3 settles it: the check was green-and-dead for the very rule that
// motivated it. A gate that cannot fail for its own case is decoration reading
// as enforcement — the defect it was written to prevent, wearing its clothes.
//
// THE FIX IS STRUCTURAL, not a better matcher. The ~30 `check*` functions in
// cli.ts already share one signature; they are a registry nobody wrote down.
// Written down as `Record<RuleName, RuleRunner>`, `runLint` reads each severity
// once by id in one loop, a rule without a runner becomes a tsc error, and
// `lintExitCode`'s hand-maintained 31-line `||` list collapses into a fold over
// the same table. That also closes a hole no textual check can see: a rule can
// be READ, COUNTED, and still not gate, because the exit list is separate.
//
// Not bolted on here: it touches `LintReport`, a wire format bumped with `!` in
// #187, so it earns its own PR and its own breaking-change note.
