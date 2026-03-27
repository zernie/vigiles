import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, parseClaudeMd } from "./validate.mjs";

describe("parseClaudeMd", () => {
  it("should parse enforced rules", () => {
    const rules = parseClaudeMd(
      "### Use barrel imports\n**Enforced by:** `eslint/no-restricted-imports`\n**Why:** Consistency.\n"
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Use barrel imports");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[0].enforcedBy, "eslint/no-restricted-imports");
  });

  it("should parse guidance-only rules", () => {
    const rules = parseClaudeMd(
      "### Use Tailwind spacing scale\n**Guidance only** — cannot be mechanically enforced\n"
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "guidance");
  });

  it("should parse rules missing annotations", () => {
    const rules = parseClaudeMd(
      "### Some rule\n**Why:** Just because.\n"
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "missing");
  });

  it("should track line numbers", () => {
    const rules = parseClaudeMd(
      "# Header\n\nSome text\n\n### First rule\n**Enforced by:** `x`\n\n### Second rule\nNo annotation\n"
    );
    assert.equal(rules[0].line, 5);
    assert.equal(rules[1].line, 8);
  });

  it("should handle multiple rules in sequence", () => {
    const rules = parseClaudeMd(
      "### Rule A\n**Enforced by:** `a`\n### Rule B\n**Guidance only**\n### Rule C\nNothing here.\n"
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].enforcement, "missing");
  });

  it("should not match deeper headings (####)", () => {
    const rules = parseClaudeMd(
      "### Real rule\n**Enforced by:** `x`\n#### Not a rule\nSome details.\n"
    );
    assert.equal(rules.length, 1);
  });

  it("should not match shallower headings (## or #)", () => {
    const rules = parseClaudeMd(
      "# Top level\n## Section\n### Actual rule\n**Enforced by:** `x`\n"
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Actual rule");
  });

  it("should handle empty file", () => {
    const rules = parseClaudeMd("");
    assert.equal(rules.length, 0);
  });

  it("should handle file with no rules", () => {
    const rules = parseClaudeMd(
      "# CLAUDE.md\n\nThis project uses TypeScript.\n"
    );
    assert.equal(rules.length, 0);
  });

  it("should stop looking for annotation at next header", () => {
    const rules = parseClaudeMd(
      "### Rule A\nSome text.\nMore text.\n### Rule B\n**Enforced by:** `x`\n"
    );
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].enforcement, "enforced");
  });
});

describe("validate", () => {
  it("should return valid when all rules are annotated", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\n**Guidance only**\n"
    );
    assert.equal(result.valid, true);
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.total, 2);
  });

  it("should return invalid when rules are missing annotations", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\nNo annotation.\n"
    );
    assert.equal(result.valid, false);
    assert.equal(result.missing, 1);
  });

  it("should handle a realistic CLAUDE.md", () => {
    const content = `# CLAUDE.md

## Code Standards

### Always use barrel file imports
**Enforced by:** \`eslint/no-restricted-imports\`
**Why:** Prevents import path drift during refactoring.

### No console.log in production
**Enforced by:** \`eslint/no-console\`
**Why:** Use logger.error which routes to Datadog.

### Use Tailwind spacing scale, no magic numbers
**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across design systems.

### API route handlers must use withAuth wrapper
**Enforced by:** \`eslint/require-with-auth\`
**Why:** Unauthenticated routes are the #1 security risk.
`;
    const result = validate(content);
    assert.equal(result.total, 4);
    assert.equal(result.enforced, 3);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.valid, true);
  });

  it("should report all missing rules", () => {
    const result = validate(
      "### A\nNo annotation.\n### B\nNo annotation.\n### C\n**Enforced by:** `x`\n"
    );
    assert.equal(result.missing, 2);
    const missingRules = result.rules.filter((r) => r.enforcement === "missing");
    assert.equal(missingRules[0].title, "A");
    assert.equal(missingRules[1].title, "B");
  });

  it("should return valid for empty file (no rules to enforce)", () => {
    const result = validate("# Just a header\n\nSome text.\n");
    assert.equal(result.valid, true);
    assert.equal(result.total, 0);
  });

  it("should handle enforcedBy extraction", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `ruff/F401`\n"
    );
    assert.equal(result.rules[0].enforcedBy, "ruff/F401");
  });

  it("should handle enforcedBy with different linter formats", () => {
    const cases = [
      { input: "**Enforced by:** `eslint/no-console`", expected: "eslint/no-console" },
      { input: "**Enforced by:** `clippy::unwrap_used`", expected: "clippy::unwrap_used" },
      { input: "**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`", expected: "rubocop/Style/FrozenStringLiteralComment" },
      { input: "**Enforced by:** `golangci-lint/errcheck`", expected: "golangci-lint/errcheck" },
    ];
    for (const { input, expected } of cases) {
      const result = validate(`### Rule\n${input}\n`);
      assert.equal(result.rules[0].enforcedBy, expected, `Failed for: ${input}`);
    }
  });
});
