import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validate,
  parseClaudeMd,
  readClaudeMd,
  validatePaths,
  expandGlobs,
  findInstructionFiles,
  loadConfig,
  validateStructure,
  resolveSchema,
  STRUCTURE_PRESETS,
} from "./validate.js";
import type { MarkerType, ParseOptions } from "./types.js";

describe("parseClaudeMd", () => {
  it("should parse enforced rules", () => {
    const rules = parseClaudeMd(
      "### Use barrel imports\n**Enforced by:** `eslint/no-restricted-imports`\n**Why:** Consistency.\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Use barrel imports");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[0].enforcedBy, "eslint/no-restricted-imports");
  });

  it("should parse guidance-only rules", () => {
    const rules = parseClaudeMd(
      "### Use Tailwind spacing scale\n**Guidance only** — cannot be mechanically enforced\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "guidance");
  });

  it("should parse rules missing annotations", () => {
    const rules = parseClaudeMd("### Some rule\n**Why:** Just because.\n");
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "missing");
  });

  it("should track line numbers", () => {
    const rules = parseClaudeMd(
      "# Header\n\nSome text\n\n### First rule\n**Enforced by:** `x`\n\n### Second rule\nNo annotation\n",
    );
    assert.equal(rules[0].line, 5);
    assert.equal(rules[1].line, 8);
  });

  it("should handle multiple rules in sequence", () => {
    const rules = parseClaudeMd(
      "### Rule A\n**Enforced by:** `a`\n### Rule B\n**Guidance only**\n### Rule C\nNothing here.\n",
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].enforcement, "missing");
  });

  it("should not match deeper headings (####)", () => {
    const rules = parseClaudeMd(
      "### Real rule\n**Enforced by:** `x`\n#### Not a rule\nSome details.\n",
    );
    assert.equal(rules.length, 1);
  });

  it("should not match shallower headings (## or #)", () => {
    const rules = parseClaudeMd(
      "# Top level\n## Section\n### Actual rule\n**Enforced by:** `x`\n",
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
      "# CLAUDE.md\n\nThis project uses TypeScript.\n",
    );
    assert.equal(rules.length, 0);
  });

  it("should stop looking for annotation at next header", () => {
    const rules = parseClaudeMd(
      "### Rule A\nSome text.\nMore text.\n### Rule B\n**Enforced by:** `x`\n",
    );
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("should parse disabled rules", () => {
    const rules = parseClaudeMd(
      "### Skipped rule\n<!-- vigiles-disable -->\n**Why:** Not relevant here.\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "disabled");
  });

  it("should handle vigiles-disable with extra whitespace", () => {
    const rules = parseClaudeMd(
      "### Skipped rule\n<!--  vigiles-disable  -->\n",
    );
    assert.equal(rules[0].enforcement, "disabled");
  });
});

describe("parseClaudeMd with checkboxes", () => {
  const opts: ParseOptions = { ruleMarkers: ["checkboxes"] };
  const bothOpts: ParseOptions = { ruleMarkers: ["headings", "checkboxes"] };

  it("should parse unchecked checkbox with enforced annotation", () => {
    const rules = parseClaudeMd(
      "- [ ] Use barrel imports\n**Enforced by:** `eslint/no-restricted-imports`\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Use barrel imports");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[0].enforcedBy, "eslint/no-restricted-imports");
  });

  it("should parse checked checkbox (lowercase x) with guidance", () => {
    const rules = parseClaudeMd(
      "- [x] Use Tailwind spacing\n**Guidance only** — cannot be enforced\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "guidance");
  });

  it("should parse checked checkbox (uppercase X) with disabled", () => {
    const rules = parseClaudeMd(
      "- [X] Skipped rule\n<!-- vigiles-disable -->\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "disabled");
  });

  it("should detect checkbox rule missing annotation", () => {
    const rules = parseClaudeMd("- [ ] Some rule\nJust a description.\n", opts);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "missing");
  });

  it("should handle multiple checkboxes in sequence", () => {
    const rules = parseClaudeMd(
      "- [ ] Rule A\n**Enforced by:** `a`\n- [x] Rule B\n**Guidance only**\n- [ ] Rule C\nNothing.\n",
      opts,
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].enforcement, "missing");
  });

  it("should track line numbers for checkbox rules", () => {
    const rules = parseClaudeMd(
      "# Header\n\nSome text\n\n- [ ] First rule\n**Enforced by:** `x`\n\n- [ ] Second rule\nNo annotation\n",
      opts,
    );
    assert.equal(rules[0].line, 5);
    assert.equal(rules[1].line, 8);
  });

  it("should not match indented checkboxes", () => {
    const rules = parseClaudeMd(
      "  - [ ] Indented item\n**Enforced by:** `x`\n",
      opts,
    );
    assert.equal(rules.length, 0);
  });

  it("should handle mixed headers and checkboxes with both markers", () => {
    const rules = parseClaudeMd(
      "### Heading rule\n**Enforced by:** `a`\n- [ ] Checkbox rule\n**Guidance only**\n### Another heading\n**Enforced by:** `b`\n",
      bothOpts,
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].title, "Heading rule");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].title, "Checkbox rule");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].title, "Another heading");
    assert.equal(rules[2].enforcement, "enforced");
  });

  it("checkbox should flush previous heading rule", () => {
    const rules = parseClaudeMd(
      "### Rule A\nSome text\n- [ ] Rule B\n**Enforced by:** `x`\n",
      bothOpts,
    );
    assert.equal(rules[0].title, "Rule A");
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].title, "Rule B");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("heading should flush previous checkbox rule", () => {
    const rules = parseClaudeMd(
      "- [ ] Rule A\nSome text\n### Rule B\n**Enforced by:** `x`\n",
      bothOpts,
    );
    assert.equal(rules[0].title, "Rule A");
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].title, "Rule B");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("should ignore checkboxes when only headings marker is enabled", () => {
    const rules = parseClaudeMd(
      "- [ ] Checkbox rule\n**Enforced by:** `x`\n### Heading rule\n**Enforced by:** `y`\n",
      { ruleMarkers: ["headings"] as MarkerType[] },
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Heading rule");
  });

  it("should ignore headings when only checkboxes marker is enabled", () => {
    const rules = parseClaudeMd(
      "### Heading rule\n**Enforced by:** `x`\n- [ ] Checkbox rule\n**Enforced by:** `y`\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Checkbox rule");
  });
});

describe("validate with checkboxes", () => {
  it("should validate checkbox-only document as valid", () => {
    const result = validate(
      "- [ ] Rule A\n**Enforced by:** `eslint/rule-a`\n\n- [x] Rule B\n**Guidance only**\n",
      { ruleMarkers: ["checkboxes"] as MarkerType[] },
    );
    assert.equal(result.valid, true);
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.total, 2);
  });

  it("should validate checkbox-only document as invalid when missing annotation", () => {
    const result = validate(
      "- [ ] Rule A\n**Enforced by:** `x`\n\n- [ ] Rule B\nNo annotation.\n",
      { ruleMarkers: ["checkboxes"] as MarkerType[] },
    );
    assert.equal(result.valid, false);
    assert.equal(result.missing, 1);
  });

  it("should validate realistic mixed document", () => {
    const content = `# CLAUDE.md

## Code Standards

### Always use barrel file imports
**Enforced by:** \`eslint/no-restricted-imports\`
**Why:** Prevents import path drift.

## Checklist

- [ ] No console.log in production
**Enforced by:** \`eslint/no-console\`

- [x] Use Tailwind spacing scale
**Guidance only** — cannot be enforced
`;
    const result = validate(content, {
      ruleMarkers: ["headings", "checkboxes"] as MarkerType[],
    });
    assert.equal(result.total, 3);
    assert.equal(result.enforced, 2);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.valid, true);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;
  let originalCwd: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return defaults when no config file exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig();
    assert.deepEqual(config.ruleMarkers, ["headings", "checkboxes"]);
    assert.deepEqual(config.rules, {
      "require-annotations": true,
      "max-lines": 500,
      "require-rule-file": "auto",
      "require-structure": false,
      "no-broken-links": true,
    });
  });

  it("should read .vigilesrc.json", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ ruleMarkers: ["headings", "checkboxes"] }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.deepEqual(config.ruleMarkers, ["headings", "checkboxes"]);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should apply strict rule pack via extends", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-strict-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ extends: "strict" }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["max-lines"], 300);
    assert.equal(config.rules["require-structure"], true);
    assert.ok(config.structures.length > 0);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should allow user overrides on top of strict pack", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-override-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({
        extends: "strict",
        rules: { "max-lines": 1000, "require-structure": false },
      }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["max-lines"], 1000);
    assert.equal(config.rules["require-structure"], false);
    assert.equal(config.rules["require-annotations"], true); // from pack
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should default to recommended when extends is omitted", () => {
    process.chdir(tmpDir);
    const config = loadConfig();
    assert.equal(config.rules["max-lines"], 500);
    assert.equal(config.rules["require-structure"], false);
  });

  it("should fall back to defaults for invalid ruleMarkers", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ ruleMarkers: ["invalid"] }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.deepEqual(config.ruleMarkers, ["headings", "checkboxes"]);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should merge rules config with defaults", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "max-lines": 200 } }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["max-lines"], 200);
    assert.equal(config.rules["require-annotations"], true);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should allow disabling rules", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({
        rules: { "require-annotations": false, "max-lines": false },
      }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["require-annotations"], false);
    assert.equal(config.rules["max-lines"], false);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("max-lines rule", () => {
  it("should pass when file is under the limit", () => {
    const content = "### Rule\n**Enforced by:** `x`\n";
    const result = validate(content, { rules: { "max-lines": 100 } });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("should fail when file exceeds the limit", () => {
    const content = "line\n".repeat(101);
    const lineCount = content.split("\n").length;
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": 100 },
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].rule, "max-lines");
    assert.ok(result.errors[0].message.includes(String(lineCount)));
    assert.ok(result.errors[0].message.includes("100"));
  });

  it("should use default limit of 500 when set to true", () => {
    const content = "line\n".repeat(501);
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": true },
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].rule, "max-lines");
    assert.ok(result.errors[0].message.includes("500"));
  });

  it("should be disabled when set to false", () => {
    const content = "line\n".repeat(1000);
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": false },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("should allow custom limit via config", () => {
    const content = "line\n".repeat(250);
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": 200 },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].message.includes("200"));
  });

  it("should pass at exactly the limit", () => {
    const content = "line\n".repeat(99) + "last line";
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": 100 },
    });
    assert.equal(result.valid, true);
  });
});

describe("no-broken-links rule", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-links-"));
    writeFileSync(join(tmpDir, "existing.md"), "# Hello\n");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "nested.md"), "# Nested\n");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should pass when all relative links resolve", () => {
    const content =
      "See [docs](existing.md) and [nested](sub/nested.md) for details.\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("should fail when a relative link target is missing", () => {
    const content = "Read the [guide](missing-file.md) first.\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].rule, "no-broken-links");
    assert.ok(result.errors[0].message.includes("missing-file.md"));
  });

  it("should skip external URLs", () => {
    const content =
      "Visit [site](https://example.com) and [mail](mailto:a@b.com).\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should skip anchor-only links", () => {
    const content = "Jump to [section](#overview).\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should handle links with fragments to existing files", () => {
    const content = "See [section](existing.md#heading) for details.\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should report multiple broken links", () => {
    const content =
      "See [a](nope.md) and [b](also-nope.md) for info.\n[c](existing.md) is fine.\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors[0].message.includes("nope.md"));
    assert.ok(result.errors[1].message.includes("also-nope.md"));
  });

  it("should be disabled when set to false", () => {
    const content = "Read the [guide](missing.md) first.\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": false },
    });
    assert.equal(result.valid, true);
  });

  it("should not run without basePath", () => {
    const content = "Read the [guide](missing.md) first.\n";
    const result = validate(content, {
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should strip link titles before resolving", () => {
    const content = 'See [guide](existing.md "Guide title") for details.\n';
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should skip links inside fenced code blocks", () => {
    const content =
      "```markdown\n[example](nonexistent.md)\n```\n[real](existing.md)\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should skip links inside nested fenced code blocks", () => {
    const content =
      "````md\n```\n[example](nonexistent.md)\n```\n````\n[real](existing.md)\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should skip links inside indented fenced code blocks", () => {
    const content =
      "   ```\n   [example](nonexistent.md)\n   ```\n[real](existing.md)\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });

  it("should skip non-http URI schemes", () => {
    const content =
      "Open [editor](vscode://file/path) or [call](tel:+1234567890).\n";
    const result = validate(content, {
      basePath: tmpDir,
      rules: { "require-annotations": false, "no-broken-links": true },
    });
    assert.equal(result.valid, true);
  });
});

describe("annotation typo detection", () => {
  it("should detect Enforced By (wrong case)", () => {
    const content =
      "### No console.log\n**Enforced By:** `eslint/no-console`\n";
    const result = validate(content);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].message.includes("near-miss"));
    assert.ok(result.errors[0].message.includes("**Enforced By:**"));
  });

  it("should detect Enforce by (wrong word)", () => {
    const content = "### No var\n**Enforce by:** `eslint/no-var`\n";
    const result = validate(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].message.includes("near-miss"));
  });

  it("should detect Enforced by without colon", () => {
    const content = "### No var\n**Enforced by** `eslint/no-var`\n";
    const result = validate(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].message.includes("near-miss"));
  });

  it("should detect Guidance (missing only)", () => {
    const content = "### Use spacing scale\n**Guidance** — not enforced\n";
    const result = validate(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].message.includes("near-miss"));
    assert.ok(result.errors[0].message.includes("**Guidance only**"));
  });

  it("should not false-positive on correct annotations", () => {
    const content =
      "### No console.log\n**Enforced by:** `eslint/no-console`\n";
    const result = validate(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("should still report missing when no near-miss found", () => {
    const content = "### Some rule\nJust a description.\n";
    const result = validate(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].message.includes("missing an enforcement"));
  });
});

describe("rule toggling", () => {
  it("should disable require-annotations when set to false", () => {
    const result = validate("### Rule\nNo annotation.\n", {
      rules: { "require-annotations": false },
    });
    assert.equal(result.valid, true);
    assert.equal(result.missing, 1);
    assert.equal(result.errors.length, 0);
  });

  it("should report both rule violations when both fail", () => {
    const lines = "### Rule\nNo annotation.\n" + "padding\n".repeat(500);
    const result = validate(lines, {
      rules: { "require-annotations": true, "max-lines": 100 },
    });
    assert.equal(result.valid, false);
    const ruleNames = result.errors.map((e) => e.rule);
    assert.ok(ruleNames.includes("require-annotations"));
    assert.ok(ruleNames.includes("max-lines"));
  });

  it("should pass when all rules are disabled", () => {
    const content = "### Rule\nNo annotation.\n" + "x\n".repeat(1000);
    const result = validate(content, {
      rules: { "require-annotations": false, "max-lines": false },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

describe("validate", () => {
  it("should return valid when all rules are annotated", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\n**Guidance only**\n",
    );
    assert.equal(result.valid, true);
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.total, 2);
  });

  it("should return invalid when rules are missing annotations", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\nNo annotation.\n",
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
      "### A\nNo annotation.\n### B\nNo annotation.\n### C\n**Enforced by:** `x`\n",
    );
    assert.equal(result.missing, 2);
    const missingRules = result.rules.filter(
      (r) => r.enforcement === "missing",
    );
    assert.equal(missingRules[0].title, "A");
    assert.equal(missingRules[1].title, "B");
  });

  it("should return valid for empty file (no rules to enforce)", () => {
    const result = validate("# Just a header\n\nSome text.\n");
    assert.equal(result.valid, true);
    assert.equal(result.total, 0);
  });

  it("should handle enforcedBy extraction", () => {
    const result = validate("### Rule\n**Enforced by:** `ruff/F401`\n");
    assert.equal(result.rules[0].enforcedBy, "ruff/F401");
  });

  it("should count disabled rules and treat them as valid", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\n<!-- vigiles-disable -->\n\n### Rule C\n**Guidance only**\n",
    );
    assert.equal(result.valid, true);
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.disabled, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.total, 3);
  });

  it("should handle enforcedBy with different linter formats", () => {
    const cases = [
      {
        input: "**Enforced by:** `eslint/no-console`",
        expected: "eslint/no-console",
      },
      {
        input: "**Enforced by:** `clippy::unwrap_used`",
        expected: "clippy::unwrap_used",
      },
      {
        input: "**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`",
        expected: "rubocop/Style/FrozenStringLiteralComment",
      },
      {
        input: "**Enforced by:** `golangci-lint/errcheck`",
        expected: "golangci-lint/errcheck",
      },
    ];
    for (const { input, expected } of cases) {
      const result = validate(`### Rule\n${input}\n`);
      assert.equal(
        result.rules[0].enforcedBy,
        expected,
        `Failed for: ${input}`,
      );
    }
  });
});

describe("readClaudeMd", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read a regular file", () => {
    const filePath = join(tmpDir, "regular.md");
    writeFileSync(filePath, "### Rule\n**Enforced by:** `x`\n");
    const { content, skipped } = readClaudeMd(filePath);
    assert.equal(skipped, false);
    assert.notEqual(content, null);
    assert.ok((content as string).includes("### Rule"));
  });

  it("should return error for missing file", () => {
    const { content, skipped, reason } = readClaudeMd(join(tmpDir, "nope.md"));
    assert.equal(content, null);
    assert.equal(skipped, false);
    assert.notEqual(reason, null);
    assert.ok((reason as string).includes("File not found"));
  });

  it("should skip symlinks by default", () => {
    const realFile = join(tmpDir, "real.md");
    const link = join(tmpDir, "link.md");
    writeFileSync(realFile, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(realFile, link);
    const { content, skipped, reason } = readClaudeMd(link);
    assert.equal(content, null);
    assert.equal(skipped, true);
    assert.notEqual(reason, null);
    assert.ok((reason as string).includes("symlink"));
  });

  it("should follow symlinks when opted in", () => {
    const realFile = join(tmpDir, "real2.md");
    const link = join(tmpDir, "link2.md");
    writeFileSync(realFile, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(realFile, link);
    const { content, skipped } = readClaudeMd(link, { followSymlinks: true });
    assert.equal(skipped, false);
    assert.notEqual(content, null);
    assert.ok((content as string).includes("### Rule"));
  });
});

describe("validatePaths", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should validate multiple files", () => {
    const file1 = join(tmpDir, "a.md");
    const file2 = join(tmpDir, "b.md");
    writeFileSync(file1, "### Rule A\n**Enforced by:** `x`\n");
    writeFileSync(file2, "### Rule B\n**Guidance only**\n");

    const { fileResults, valid } = validatePaths([file1, file2]);
    assert.equal(valid, true);
    assert.equal(fileResults.length, 2);
    assert.notEqual(fileResults[0].result, null);
    assert.equal(fileResults[0].result?.enforced, 1);
    assert.notEqual(fileResults[1].result, null);
    assert.equal(fileResults[1].result?.guidanceOnly, 1);
  });

  it("should fail if any file has missing annotations", () => {
    const file1 = join(tmpDir, "ok.md");
    const file2 = join(tmpDir, "bad.md");
    writeFileSync(file1, "### Rule\n**Enforced by:** `x`\n");
    writeFileSync(file2, "### Rule\nNo annotation.\n");

    const { valid } = validatePaths([file1, file2]);
    assert.equal(valid, false);
  });

  it("should fail if any file is missing", () => {
    const file1 = join(tmpDir, "exists.md");
    writeFileSync(file1, "### Rule\n**Enforced by:** `x`\n");

    const { valid } = validatePaths([file1, join(tmpDir, "missing.md")]);
    assert.equal(valid, false);
  });

  it("should skip symlinks by default but not fail", () => {
    const real = join(tmpDir, "real3.md");
    const link = join(tmpDir, "link3.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([real, link]);
    assert.equal(valid, true);
    assert.equal(fileResults[1].skipped, true);
  });

  it("should validate symlinks when follow-symlinks is enabled", () => {
    const real = join(tmpDir, "real4.md");
    const link = join(tmpDir, "link4.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([link], {
      followSymlinks: true,
    });
    assert.equal(valid, true);
    assert.equal(fileResults[0].skipped, false);
    assert.notEqual(fileResults[0].result, null);
    assert.equal(fileResults[0].result?.enforced, 1);
  });
});

describe("expandGlobs", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-glob-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should pass through plain paths unchanged", () => {
    const result = expandGlobs(["CLAUDE.md", "foo/AGENTS.md"]);
    assert.deepEqual(result, ["CLAUDE.md", "foo/AGENTS.md"]);
  });

  it("should expand glob patterns into matching files", () => {
    writeFileSync(join(tmpDir, "a.md"), "# A\n");
    writeFileSync(join(tmpDir, "b.md"), "# B\n");
    writeFileSync(join(tmpDir, "c.txt"), "not md\n");

    const result = expandGlobs([join(tmpDir, "*.md")]);
    assert.equal(result.length, 2);
    assert.ok(result.some((p) => p.endsWith("a.md")));
    assert.ok(result.some((p) => p.endsWith("b.md")));
    assert.ok(!result.some((p) => p.endsWith("c.txt")));
  });

  it("should expand recursive globs", () => {
    const subDir = join(tmpDir, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "nested.md"), "# Nested\n");

    const result = expandGlobs([join(tmpDir, "**/*.md")]);
    assert.ok(result.some((p) => p.endsWith("nested.md")));
  });

  it("should return empty for globs matching nothing", () => {
    const result = expandGlobs([join(tmpDir, "*.nonexistent")]);
    assert.deepEqual(result, []);
  });

  it("should mix plain paths and globs", () => {
    const result = expandGlobs(["plain.md", join(tmpDir, "*.md")]);
    assert.equal(result[0], "plain.md");
    assert.ok(result.length > 1);
  });
});

describe("require-rule-file", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-rule-file-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should not check rules when disabled", () => {
    const result = validate("### Rule\n**Enforced by:** `eslint/fake-xyz`\n", {
      rules: { "require-rule-file": false },
      basePath: tmpDir,
    });
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
  });

  it("should skip when no basePath is provided", () => {
    const result = validate("### Rule\n**Enforced by:** `eslint/fake-xyz`\n", {
      rules: { "require-rule-file": "auto" },
    });
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
  });

  it("should detect eslint built-in rules via API", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/no-console`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
    assert.ok(result.detectedLinters.some((l) => l.name === "eslint"));
  });

  it("should error on nonexistent eslint rule", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/completely-fake-rule-xyz`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("completely-fake-rule-xyz"));
    assert.ok(ruleErrors[0].message.includes("eslint"));
  });

  it("should report detected linters with rule count", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/no-console`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const eslint = result.detectedLinters.find((l) => l.name === "eslint");
    assert.ok(eslint);
    assert.ok(typeof eslint?.ruleCount === "number" && eslint.ruleCount > 0);
  });

  it("should detect ruff rules via CLI", () => {
    const result = validate("### Rule\n**Enforced by:** `ruff/E501`\n", {
      rules: { "require-rule-file": "auto" },
      basePath: process.cwd(),
    });
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 0);
    assert.ok(result.detectedLinters.some((l) => l.name === "ruff"));
  });

  it("should error on nonexistent ruff rule", () => {
    const result = validate("### Rule\n**Enforced by:** `ruff/FAKE999`\n", {
      rules: { "require-rule-file": "auto" },
      basePath: process.cwd(),
    });
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("FAKE999"));
  });

  it("should detect clippy rules via CLI", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `clippy::needless_return`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 0);
    assert.ok(result.detectedLinters.some((l) => l.name === "clippy"));
  });

  it("should skip gracefully when stylelint is not installed", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `stylelint/color-no-invalid-hex`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    // stylelint not installed, no resolver found -> skip
    assert.equal(ruleErrors.length, 0);
  });

  it("should detect pylint rules via CLI", () => {
    const result = validate("### Rule\n**Enforced by:** `pylint/C0301`\n", {
      rules: { "require-rule-file": "auto" },
      basePath: process.cwd(),
    });
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 0);
    assert.ok(result.detectedLinters.some((l) => l.name === "pylint"));
  });

  it("should error on nonexistent pylint rule", () => {
    const result = validate("### Rule\n**Enforced by:** `pylint/ZZZZ9999`\n", {
      rules: { "require-rule-file": "auto" },
      basePath: process.cwd(),
    });
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("ZZZZ9999"));
  });

  it("should detect rubocop rules via CLI", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 0);
    assert.ok(result.detectedLinters.some((l) => l.name === "rubocop"));
  });

  it("should error on nonexistent rubocop cop", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `rubocop/Fake/NonExistentCop`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("Fake/NonExistentCop"));
  });

  it("should check rulesDir for custom rubocop cops", () => {
    const rulesDir = join(tmpDir, "rubocop-custom");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "MyCustomCop.rb"), "# custom cop\n");

    const result = validate(
      "### Rule A\n**Enforced by:** `rubocop-custom/MyCustomCop`\n### Rule B\n**Enforced by:** `rubocop-custom/MissingCop`\n",
      {
        rules: { "require-rule-file": "auto" },
        basePath: tmpDir,
        linters: { "rubocop-custom": { rulesDir: "rubocop-custom" } },
      },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("MissingCop"));
  });

  it("should error on nonexistent clippy lint", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `clippy::completely_fake_lint_xyz`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("completely_fake_lint_xyz"));
  });

  it("should skip unknown linters with no config", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `unknown-tool/some-rule`\n",
      { rules: { "require-rule-file": "auto" }, basePath: tmpDir },
    );
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
  });

  it("should skip rules with unsafe characters in name", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/no-console; rm -rf /`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    // Should not crash or execute shell commands
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
  });

  it("should check rulesDir for custom linters", () => {
    const rulesDir = join(tmpDir, "my-rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "check-foo.js"), "module.exports = {};\n");

    const result = validate(
      "### Rule A\n**Enforced by:** `my-tool/check-foo`\n### Rule B\n**Enforced by:** `my-tool/check-bar`\n",
      {
        rules: { "require-rule-file": "auto" },
        basePath: tmpDir,
        linters: { "my-tool": { rulesDir: "my-rules" } },
      },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("check-bar"));
  });

  it("should error when configured rulesDir does not exist", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `my-tool/check-foo`\n",
      {
        rules: { "require-rule-file": "auto" },
        basePath: tmpDir,
        linters: { "my-tool": { rulesDir: "nonexistent-dir" } },
      },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("does not exist"));
  });

  it("should skip all CLI linters gracefully when not on PATH", () => {
    // Use a fake PATH so no CLI tools are found
    const origPath = process.env.PATH;
    process.env.PATH = tmpDir; // empty dir, no binaries
    try {
      const content = [
        "### R1\n**Enforced by:** `ruff/E501`",
        "### R2\n**Enforced by:** `clippy::needless_return`",
        "### R3\n**Enforced by:** `pylint/C0301`",
        "### R4\n**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`",
      ].join("\n");
      const result = validate(content, {
        rules: { "require-rule-file": "auto" },
        basePath: tmpDir,
      });
      // No CLI tools found → no require-rule-file errors (all skipped)
      const ruleErrors = result.errors.filter(
        (e) => e.rule === "require-rule-file",
      );
      assert.equal(ruleErrors.length, 0);
      // None should be detected
      assert.equal(
        result.detectedLinters.filter((l) =>
          ["ruff", "clippy", "pylint", "rubocop"].includes(l.name),
        ).length,
        0,
      );
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("should not error on eslint rules when require-rule-file is disabled", () => {
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/no-console`\n",
      { rules: { "require-rule-file": false }, basePath: tmpDir },
    );
    assert.equal(
      result.errors.filter((e) => e.rule === "require-rule-file").length,
      0,
    );
    assert.equal(result.detectedLinters.length, 0);
  });

  it("should handle eslint plugin-style rule names with slash", () => {
    // eslint/import/no-unresolved — plugin not installed, should error
    const result = validate(
      "### Rule\n**Enforced by:** `eslint/import/no-unresolved`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    // Should error because eslint-plugin-import isn't installed
    assert.equal(ruleErrors.length, 1);
    assert.ok(ruleErrors[0].message.includes("import/no-unresolved"));
  });

  it("should skip uninstalled eslint plugin linter names gracefully", () => {
    // @typescript-eslint/no-explicit-any — plugin not installed, skip
    const result = validate(
      "### Rule\n**Enforced by:** `@typescript-eslint/no-explicit-any`\n",
      { rules: { "require-rule-file": "auto" }, basePath: process.cwd() },
    );
    const ruleErrors = result.errors.filter(
      (e) => e.rule === "require-rule-file",
    );
    // Plugin not installed, so no resolver found -> skip (no error in auto mode)
    assert.equal(ruleErrors.length, 0);
  });

  // Config-enabled checks ("auto" mode now checks if rule is enabled in linter config)
  // Config-enabled checks: "auto" mode verifies rules are enabled in linter config
  describe("config-enabled checks", () => {
    // --- ESLint ---
    describe("eslint", () => {
      let eslintDir: string;

      before(() => {
        eslintDir = mkdtempSync(join(tmpdir(), "vigiles-eslint-cfg-"));
        writeFileSync(
          join(eslintDir, "package.json"),
          JSON.stringify({ name: "test", private: true }),
        );
        // Symlink node_modules from cwd so eslint is available
        try {
          symlinkSync(
            join(process.cwd(), "node_modules"),
            join(eslintDir, "node_modules"),
          );
        } catch {
          // already exists
        }
        writeFileSync(
          join(eslintDir, "eslint.config.mjs"),
          'export default [{ rules: { "no-console": "off", "no-unused-vars": "warn", "no-undef": "error" } }];\n',
        );
      });

      after(() => {
        rmSync(eslintDir, { recursive: true, force: true });
      });

      it("should error when rule is disabled in config", () => {
        const result = validate(
          "### No console\n**Enforced by:** `eslint/no-console`\n",
          { rules: { "require-rule-file": "auto" }, basePath: eslintDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
        assert.ok(ruleErrors[0].message.includes("no-console"));
      });

      it("should not error when rule is enabled (warn)", () => {
        const result = validate(
          "### No unused vars\n**Enforced by:** `eslint/no-unused-vars`\n",
          { rules: { "require-rule-file": "auto" }, basePath: eslintDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should not error when rule is enabled (error)", () => {
        const result = validate(
          "### No undef\n**Enforced by:** `eslint/no-undef`\n",
          { rules: { "require-rule-file": "auto" }, basePath: eslintDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip config check in catalog-only mode", () => {
        const result = validate(
          "### No console\n**Enforced by:** `eslint/no-console`\n",
          {
            rules: { "require-rule-file": "catalog-only" },
            basePath: eslintDir,
          },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip config check when no config file exists", () => {
        const result = validate(
          "### No console\n**Enforced by:** `eslint/no-console`\n",
          { rules: { "require-rule-file": "auto" }, basePath: tmpDir },
        );
        const ruleErrors = result.errors.filter((e) =>
          e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should return unknown for rules not in config", () => {
        const result = validate(
          "### No eval\n**Enforced by:** `eslint/no-eval`\n",
          { rules: { "require-rule-file": "auto" }, basePath: eslintDir },
        );
        const ruleErrors = result.errors.filter((e) =>
          e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });
    });

    // --- Ruff ---
    describe("ruff", () => {
      let ruffDir: string;

      before(() => {
        ruffDir = mkdtempSync(join(tmpdir(), "vigiles-ruff-cfg-"));
        writeFileSync(
          join(ruffDir, "ruff.toml"),
          '[lint]\nselect = ["E", "F"]\nignore = ["E501"]\n',
        );
        // ruff --show-settings needs a .py file to resolve against
        writeFileSync(join(ruffDir, "dummy.py"), "");
      });

      after(() => {
        rmSync(ruffDir, { recursive: true, force: true });
      });

      it("should error when rule is ignored in config", () => {
        const result = validate(
          "### Line length\n**Enforced by:** `ruff/E501`\n",
          { rules: { "require-rule-file": "auto" }, basePath: ruffDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
        assert.ok(ruleErrors[0].message.includes("E501"));
      });

      it("should not error when rule is selected", () => {
        const result = validate("### Imports\n**Enforced by:** `ruff/E401`\n", {
          rules: { "require-rule-file": "auto" },
          basePath: ruffDir,
        });
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should not error when rule is enabled via prefix select", () => {
        // F401 is enabled because "F" is in the select list
        const result = validate(
          "### Unused import\n**Enforced by:** `ruff/F401`\n",
          { rules: { "require-rule-file": "auto" }, basePath: ruffDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should error when rule is not in any selected group", () => {
        // W rules are not selected (only E and F are)
        const result = validate(
          "### Whitespace\n**Enforced by:** `ruff/W291`\n",
          { rules: { "require-rule-file": "auto" }, basePath: ruffDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
      });

      it("should skip config check in catalog-only mode", () => {
        const result = validate(
          "### Line length\n**Enforced by:** `ruff/E501`\n",
          { rules: { "require-rule-file": "catalog-only" }, basePath: ruffDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });
    });

    // --- Pylint ---
    describe("pylint", () => {
      let pylintDir: string;

      before(() => {
        pylintDir = mkdtempSync(join(tmpdir(), "vigiles-pylint-cfg-"));
        writeFileSync(
          join(pylintDir, ".pylintrc"),
          "[MESSAGES CONTROL]\ndisable=C0301\n",
        );
      });

      after(() => {
        rmSync(pylintDir, { recursive: true, force: true });
      });

      it("should error when rule is disabled in config", () => {
        const result = validate(
          "### Line length\n**Enforced by:** `pylint/C0301`\n",
          { rules: { "require-rule-file": "auto" }, basePath: pylintDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
        assert.ok(ruleErrors[0].message.includes("C0301"));
      });

      it("should not error when rule is enabled", () => {
        // C0103 (invalid-name) is enabled by default
        const result = validate(
          "### Names\n**Enforced by:** `pylint/C0103`\n",
          { rules: { "require-rule-file": "auto" }, basePath: pylintDir },
        );
        const ruleErrors = result.errors.filter(
          (e) =>
            e.rule === "require-rule-file" &&
            e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip config check in catalog-only mode", () => {
        const result = validate(
          "### Line length\n**Enforced by:** `pylint/C0301`\n",
          {
            rules: { "require-rule-file": "catalog-only" },
            basePath: pylintDir,
          },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });
    });

    // --- RuboCop ---
    describe("rubocop", () => {
      let rubocopDir: string;

      before(() => {
        rubocopDir = mkdtempSync(join(tmpdir(), "vigiles-rubocop-cfg-"));
        writeFileSync(
          join(rubocopDir, ".rubocop.yml"),
          "Style/FrozenStringLiteralComment:\n  Enabled: false\nStyle/StringLiterals:\n  Enabled: true\n  EnforcedStyle: double_quotes\n",
        );
      });

      after(() => {
        rmSync(rubocopDir, { recursive: true, force: true });
      });

      it("should error when cop is disabled in config", () => {
        const result = validate(
          "### Frozen string\n**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`\n",
          { rules: { "require-rule-file": "auto" }, basePath: rubocopDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
        assert.ok(
          ruleErrors[0].message.includes("Style/FrozenStringLiteralComment"),
        );
      });

      it("should not error when cop is enabled", () => {
        const result = validate(
          "### String literals\n**Enforced by:** `rubocop/Style/StringLiterals`\n",
          { rules: { "require-rule-file": "auto" }, basePath: rubocopDir },
        );
        const ruleErrors = result.errors.filter(
          (e) =>
            e.rule === "require-rule-file" &&
            e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip config check in catalog-only mode", () => {
        const result = validate(
          "### Frozen string\n**Enforced by:** `rubocop/Style/FrozenStringLiteralComment`\n",
          {
            rules: { "require-rule-file": "catalog-only" },
            basePath: rubocopDir,
          },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });
    });

    // --- Clippy ---
    describe("clippy", () => {
      let clippyDir: string;

      before(() => {
        clippyDir = mkdtempSync(join(tmpdir(), "vigiles-clippy-cfg-"));
        writeFileSync(
          join(clippyDir, "Cargo.toml"),
          '[package]\nname = "test"\nversion = "0.1.0"\n\n[lints.clippy]\nneedless_return = "allow"\ndbg_macro = "warn"\n',
        );
      });

      after(() => {
        rmSync(clippyDir, { recursive: true, force: true });
      });

      it("should error when lint is set to allow", () => {
        const result = validate(
          "### Return\n**Enforced by:** `clippy::needless_return`\n",
          { rules: { "require-rule-file": "auto" }, basePath: clippyDir },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 1);
        assert.ok(ruleErrors[0].message.includes("exists but is disabled"));
        assert.ok(ruleErrors[0].message.includes("needless_return"));
      });

      it("should not error when lint is set to warn", () => {
        const result = validate(
          "### Dbg\n**Enforced by:** `clippy::dbg_macro`\n",
          { rules: { "require-rule-file": "auto" }, basePath: clippyDir },
        );
        const ruleErrors = result.errors.filter(
          (e) =>
            e.rule === "require-rule-file" &&
            e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should return unknown for unconfigured lints", () => {
        // unwrap_used is not in Cargo.toml [lints.clippy]
        const result = validate(
          "### Unwrap\n**Enforced by:** `clippy::unwrap_used`\n",
          { rules: { "require-rule-file": "auto" }, basePath: clippyDir },
        );
        const ruleErrors = result.errors.filter(
          (e) =>
            e.rule === "require-rule-file" &&
            e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip config check in catalog-only mode", () => {
        const result = validate(
          "### Return\n**Enforced by:** `clippy::needless_return`\n",
          {
            rules: { "require-rule-file": "catalog-only" },
            basePath: clippyDir,
          },
        );
        const ruleErrors = result.errors.filter(
          (e) => e.rule === "require-rule-file",
        );
        assert.equal(ruleErrors.length, 0);
      });

      it("should skip when no Cargo.toml exists", () => {
        const result = validate(
          "### Return\n**Enforced by:** `clippy::needless_return`\n",
          { rules: { "require-rule-file": "auto" }, basePath: tmpDir },
        );
        const ruleErrors = result.errors.filter(
          (e) =>
            e.rule === "require-rule-file" &&
            e.message.includes("exists but is disabled"),
        );
        assert.equal(ruleErrors.length, 0);
      });
    });
  });
});

describe("findInstructionFiles", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-find-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty when no files exist", () => {
    const result = findInstructionFiles(tmpDir);
    assert.deepEqual(result, []);
  });

  it("should find CLAUDE.md by default", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Test\n");
    const result = findInstructionFiles(tmpDir);
    assert.deepEqual(result, ["CLAUDE.md"]);
  });

  it("should find custom files list", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Test\n");
    const result = findInstructionFiles(tmpDir, [
      "CLAUDE.md",
      "AGENTS.md",
      ".cursorrules",
    ]);
    assert.ok(result.includes("CLAUDE.md"));
    assert.ok(result.includes("AGENTS.md"));
    assert.ok(!result.includes(".cursorrules"));
  });

  it("should only return files that exist", () => {
    const result = findInstructionFiles(tmpDir, [
      "CLAUDE.md",
      "nonexistent.md",
    ]);
    assert.deepEqual(result, ["CLAUDE.md"]);
  });
});

describe("validateStructure (mdschema CLI)", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-struct-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSchema(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  function writeMd(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("should pass valid file against schema", () => {
    const schema = writeSchema(
      "s1.yml",
      "heading_rules:\n  no_skip_levels: true\n  max_depth: 3\n",
    );
    const md = writeMd("t1.md", "# Title\n\n## Section\n\n### Sub\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.equal(errors.length, 0);
  });

  it("should detect skipped heading levels", () => {
    const schema = writeSchema(
      "s2.yml",
      "heading_rules:\n  no_skip_levels: true\n",
    );
    const md = writeMd("t2.md", "# Title\n\n### Skipped h2\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.rule === "require-structure"));
  });

  it("should detect headings exceeding max depth", () => {
    const schema = writeSchema("s3.yml", "heading_rules:\n  max_depth: 3\n");
    const md = writeMd(
      "t3.md",
      "# Title\n\n## Section\n\n### Sub\n\n#### Too deep\n",
    );
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.ok(errors.length > 0);
  });

  it("should require frontmatter when specified", () => {
    const schema = writeSchema(
      "s4.yml",
      'frontmatter:\n  fields:\n    - name: "description"\n      required: true\n',
    );
    const md = writeMd("t4.md", "# No frontmatter\n\nJust text.\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.message.includes("frontmatter")));
  });

  it("should pass when frontmatter has required fields", () => {
    const schema = writeSchema(
      "s5.yml",
      'frontmatter:\n  fields:\n    - name: "description"\n      required: true\n',
    );
    const md = writeMd("t5.md", "---\ndescription: hello\n---\n\n# Skill\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.equal(errors.length, 0);
  });

  it("should error on missing required section", () => {
    const schema = writeSchema(
      "s6.yml",
      'structure:\n  - heading:\n      pattern: "# .+"\n    allow_additional: true\n    children:\n      - heading: "## Commands"\n',
    );
    const md = writeMd("t6.md", "# Project\n\n## Other\n\nNo commands.\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.message.includes("Commands")));
  });

  it("should pass when required section is present", () => {
    const schema = writeSchema(
      "s7.yml",
      'structure:\n  - heading:\n      pattern: "# .+"\n    allow_additional: true\n    children:\n      - heading: "## Commands"\n',
    );
    const md = writeMd("t7.md", "# Project\n\n## Commands\n\nnpm test\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.equal(errors.length, 0);
  });

  it("should parse line numbers from mdschema output", () => {
    const schema = writeSchema(
      "s8.yml",
      "heading_rules:\n  no_skip_levels: true\n",
    );
    const md = writeMd("t8.md", "# Title\n\n### Skipped\n");
    const { errors, available } = validateStructure(md, schema);
    assert.ok(available, "mdschema must be installed");
    assert.ok(errors.length > 0);
    assert.ok(errors[0].line > 0);
  });
});

describe("resolveSchema", () => {
  it("should resolve 'claude-md' preset to a file path", () => {
    const schema = resolveSchema("claude-md");
    assert.ok(schema);
    assert.ok(typeof schema === "string");
    assert.ok(schema.endsWith("claude-md.yml"));
  });

  it("should resolve 'skill' preset to a file path", () => {
    const schema = resolveSchema("skill");
    assert.ok(schema);
    assert.ok(typeof schema === "string");
    assert.ok(schema.endsWith("skill.yml"));
  });

  it("should return null for unknown preset/missing file", () => {
    const schema = resolveSchema("nonexistent");
    assert.equal(schema, null);
  });

  it("should return null for non-string schemas", () => {
    const schema = resolveSchema({ sections: [] });
    assert.equal(schema, null);
  });
});

describe("require-structure via validate()", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-vstruct-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should not check structure when rule is disabled (default)", () => {
    const result = validate("# Title\n", {
      rules: { "require-annotations": false, "require-rule-file": false },
    });
    assert.equal(result.valid, true);
  });

  it("should check structure when enabled and file matches", () => {
    const schemaPath = join(tmpDir, "req-cmd.yml");
    writeFileSync(
      schemaPath,
      'structure:\n  - heading:\n      pattern: "# .+"\n    allow_additional: true\n    children:\n      - heading: "## Commands"\n',
    );
    const mdPath = join(tmpDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Project\n\nNo commands section here.\n");
    const structures = [{ files: "CLAUDE.md", schema: schemaPath }];
    const result = validate("# Project\n\nNo commands section here.\n", {
      rules: {
        "require-annotations": false,
        "max-lines": false,
        "require-rule-file": false,
        "require-structure": true,
      },
      structures,
      filePath: mdPath,
    });
    assert.ok(
      !result.errors.some((e) => e.message.includes("mdschema is not")),
      "mdschema must be installed",
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) => e.rule === "require-structure" && e.message.includes("Commands"),
      ),
    );
  });

  it("should not check structure when file does not match glob", () => {
    const schemaPath = join(tmpDir, "fm.yml");
    writeFileSync(
      schemaPath,
      'frontmatter:\n  fields:\n    - name: "description"\n      required: true\n',
    );
    const structures = [{ files: "SKILL.md", schema: schemaPath }];
    const result = validate("# Project\n\nNo frontmatter.\n", {
      rules: {
        "require-annotations": false,
        "max-lines": false,
        "require-rule-file": false,
        "require-structure": true,
      },
      structures,
      filePath: "CLAUDE.md",
    });
    assert.equal(result.valid, true);
  });

  it("should use bundled skill preset against real skill files", () => {
    const structures = [
      { files: "**/SKILL.md", schema: STRUCTURE_PRESETS["skill"] },
    ];
    const mdPath = join(tmpDir, "SKILL.md");
    writeFileSync(
      mdPath,
      "---\nname: test\ndescription: A test\n---\n\n# Test Skill\n",
    );
    const result = validate(
      "---\nname: test\ndescription: A test\n---\n\n# Test Skill\n",
      {
        rules: {
          "require-annotations": false,
          "max-lines": false,
          "require-rule-file": false,
          "require-structure": true,
        },
        structures,
        filePath: mdPath,
      },
    );
    if (result.errors.some((e) => e.message.includes("mdschema is not"))) {
      return;
    }
    assert.equal(result.valid, true);
  });
});
