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

  it("ignores vigiles:enforce markers inside fenced code blocks", () => {
    // Illustrative example in docs/inline-mode.md would otherwise get
    // picked up as a live rule.
    const { rules, errors } = parseInlineRules(
      `# Docs

Example usage:

\`\`\`md
<!-- vigiles:enforce eslint/no-console "Use structured logger" -->
<!-- vigiles:enforce ruff/F401 "No unused imports" -->
\`\`\`

And a real one outside the fence:

<!-- vigiles:enforce eslint/no-eval "Never eval user input" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores markers inside tilde-fenced code blocks", () => {
    const { rules } = parseInlineRules(
      `~~~md
<!-- vigiles:enforce eslint/no-console "inside fence" -->
~~~
<!-- vigiles:enforce eslint/no-eval "outside fence" -->
`,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores markers inside inline code spans in prose", () => {
    // Prose that describes the syntax with a backtick-wrapped example
    // must not trigger "malformed vigiles:enforce".
    const { rules, errors } = parseInlineRules(
      `You add \`<!-- vigiles:enforce eslint/no-console "why" -->\` comments to adopt gradually.

Real rule below:

<!-- vigiles:enforce eslint/no-eval "Never eval" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores ellipsis placeholders inside inline code spans", () => {
    const { rules, errors } = parseInlineRules(
      `You add \`<!-- vigiles:enforce ... -->\` comments to adopt gradually.
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 0);
  });

  it("handles nested backtick fences of different lengths", () => {
    // Opening with 4 backticks, closing with 3 inside should NOT close
    // the outer block — only a 4+ backtick close matches.
    const { rules } = parseInlineRules(
      `\`\`\`\`md
\`\`\`
<!-- vigiles:enforce eslint/no-console "inside outer" -->
\`\`\`
\`\`\`\`
<!-- vigiles:enforce eslint/no-eval "outside" -->
`,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
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

  it("returns false for markers trapped inside fenced code blocks", () => {
    assert.equal(
      hasInlineRules(
        `# Docs\n\n\`\`\`md\n<!-- vigiles:enforce eslint/no-console "x" -->\n\`\`\`\n`,
      ),
      false,
    );
  });

  it("returns true only for parseable rules outside fences", () => {
    assert.equal(
      hasInlineRules(
        `\`\`\`md\n<!-- vigiles:enforce eslint/no-console "inside" -->\n\`\`\`\n<!-- vigiles:enforce eslint/no-eval "outside" -->\n`,
      ),
      true,
    );
  });
});
