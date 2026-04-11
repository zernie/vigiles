/**
 * Tests for the inline-rule parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseInlineRules, hasInlineRules } from "./inline.js";

describe("parseInlineRules", () => {
  it("extracts a single enforce comment", () => {
    const { rules, errors } = parseInlineRules(
      `# Project

<!-- vigiles:enforce eslint/no-console "Use structured logger" -->

## Logging

All output through logger.ts.
`,
    );
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-console");
    assert.equal(rules[0].why, "Use structured logger");
    assert.equal(rules[0].line, 3);
  });

  it("extracts multiple enforce comments and tracks line numbers", () => {
    const content = `# Doc
<!-- vigiles:enforce eslint/no-console "a" -->
text
<!-- vigiles:enforce ruff/F401 "b" -->
`;
    const { rules, errors } = parseInlineRules(content);
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].linterRule, "eslint/no-console");
    assert.equal(rules[0].line, 2);
    assert.equal(rules[1].linterRule, "ruff/F401");
    assert.equal(rules[1].line, 4);
  });

  it("supports plugin-scoped rule names with slashes", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:enforce eslint/@typescript-eslint/no-floating-promises "Await or void" -->`,
    );
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(
      rules[0].linterRule,
      "eslint/@typescript-eslint/no-floating-promises",
    );
  });

  it("reports malformed vigiles:enforce as a parse error", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:enforce eslint/no-console no quotes here -->`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Malformed vigiles:enforce/);
  });

  it("reports unknown vigiles markers", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:strengthen eslint/no-console -->`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unknown vigiles marker "strengthen"/);
  });

  it("returns empty results for a file with no vigiles comments", () => {
    const { rules, errors } = parseInlineRules(
      `# Plain\n\nJust prose, no rules.\n`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 0);
  });

  it("skips the compiled-file hash marker without reporting an error", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:sha256:abc123 compiled from CLAUDE.md.spec.ts -->
# Project
<!-- vigiles:enforce eslint/no-console "why" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
  });
});

describe("hasInlineRules", () => {
  it("returns true when a valid enforce comment exists", () => {
    assert.equal(
      hasInlineRules(`<!-- vigiles:enforce eslint/no-console "why" -->`),
      true,
    );
  });

  it("returns false for plain markdown", () => {
    assert.equal(hasInlineRules(`# Title\n\nparagraph\n`), false);
  });

  it("returns false for a malformed marker", () => {
    assert.equal(
      hasInlineRules(`<!-- vigiles:enforce eslint/no-console no-quotes -->`),
      false,
    );
  });
});
