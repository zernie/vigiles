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
  discoverInstructionFiles,
  loadConfig,
} from "./validate.mjs";

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
      "### Skipped rule\n<!-- agent-lint-disable -->\n**Why:** Not relevant here.\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "disabled");
  });

  it("should handle agent-lint-disable with extra whitespace", () => {
    const rules = parseClaudeMd(
      "### Skipped rule\n<!--  agent-lint-disable  -->\n",
    );
    assert.equal(rules[0].enforcement, "disabled");
  });
});

describe("parseClaudeMd with checkboxes", () => {
  const opts = { ruleMarkers: ["checkboxes"] };
  const bothOpts = { ruleMarkers: ["headings", "checkboxes"] };

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
      "- [X] Skipped rule\n<!-- agent-lint-disable -->\n",
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
      { ruleMarkers: ["headings"] },
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
      { ruleMarkers: ["checkboxes"] },
    );
    assert.equal(result.valid, true);
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.total, 2);
  });

  it("should validate checkbox-only document as invalid when missing annotation", () => {
    const result = validate(
      "- [ ] Rule A\n**Enforced by:** `x`\n\n- [ ] Rule B\nNo annotation.\n",
      { ruleMarkers: ["checkboxes"] },
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
      ruleMarkers: ["headings", "checkboxes"],
    });
    assert.equal(result.total, 3);
    assert.equal(result.enforced, 2);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.valid, true);
  });
});

describe("loadConfig", () => {
  let tmpDir;
  let originalCwd;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-config-"));
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
    });
  });

  it("should read .agent-lintrc.json", () => {
    const configDir = mkdtempSync(join(tmpdir(), "agent-lint-config-"));
    writeFileSync(
      join(configDir, ".agent-lintrc.json"),
      JSON.stringify({ ruleMarkers: ["headings", "checkboxes"] }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.deepEqual(config.ruleMarkers, ["headings", "checkboxes"]);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should fall back to defaults for invalid ruleMarkers", () => {
    const configDir = mkdtempSync(join(tmpdir(), "agent-lint-config-"));
    writeFileSync(
      join(configDir, ".agent-lintrc.json"),
      JSON.stringify({ ruleMarkers: ["invalid"] }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.deepEqual(config.ruleMarkers, ["headings", "checkboxes"]);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("should merge rules config with defaults", () => {
    const configDir = mkdtempSync(join(tmpdir(), "agent-lint-config-"));
    writeFileSync(
      join(configDir, ".agent-lintrc.json"),
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
    const configDir = mkdtempSync(join(tmpdir(), "agent-lint-config-"));
    writeFileSync(
      join(configDir, ".agent-lintrc.json"),
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
      "### Rule A\n**Enforced by:** `eslint/rule-a`\n\n### Rule B\n<!-- agent-lint-disable -->\n\n### Rule C\n**Guidance only**\n",
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
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should read a regular file", () => {
    const filePath = join(tmpDir, "regular.md");
    writeFileSync(filePath, "### Rule\n**Enforced by:** `x`\n");
    const { content, skipped } = readClaudeMd(filePath);
    assert.equal(skipped, false);
    assert.ok(content.includes("### Rule"));
  });

  it("should return error for missing file", () => {
    const { content, skipped, reason } = readClaudeMd(join(tmpDir, "nope.md"));
    assert.equal(content, null);
    assert.equal(skipped, false);
    assert.ok(reason.includes("File not found"));
  });

  it("should skip symlinks by default", () => {
    const realFile = join(tmpDir, "real.md");
    const link = join(tmpDir, "link.md");
    writeFileSync(realFile, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(realFile, link);
    const { content, skipped, reason } = readClaudeMd(link);
    assert.equal(content, null);
    assert.equal(skipped, true);
    assert.ok(reason.includes("symlink"));
  });

  it("should follow symlinks when opted in", () => {
    const realFile = join(tmpDir, "real2.md");
    const link = join(tmpDir, "link2.md");
    writeFileSync(realFile, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(realFile, link);
    const { content, skipped } = readClaudeMd(link, { followSymlinks: true });
    assert.equal(skipped, false);
    assert.ok(content.includes("### Rule"));
  });
});

describe("validatePaths", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-test-"));
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
    assert.equal(fileResults[0].result.enforced, 1);
    assert.equal(fileResults[1].result.guidanceOnly, 1);
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
    assert.equal(fileResults[0].result.enforced, 1);
  });
});

describe("expandGlobs", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-glob-"));
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
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-rule-file-"));
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
    assert.ok(eslint.ruleCount > 0);
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
});

describe("discoverInstructionFiles", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-lint-discover-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return empty when no agents detected", () => {
    const result = discoverInstructionFiles(tmpDir);
    assert.equal(result.detected.length, 0);
    assert.equal(result.files.length, 0);
    assert.equal(result.missing.length, 0);
  });

  it("should detect Claude Code via .claude/ dir and find CLAUDE.md", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Test\n");
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "Claude Code"));
    assert.ok(result.files.includes("CLAUDE.md"));
    assert.equal(result.missing.length, 0);
  });

  it("should error when Claude Code detected but CLAUDE.md missing", () => {
    // .claude/ already exists from previous test
    const dir = mkdtempSync(join(tmpdir(), "agent-lint-discover2-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const result = discoverInstructionFiles(dir);
    assert.ok(result.detected.some((d) => d.name === "Claude Code"));
    assert.equal(result.files.length, 0);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].tool, "Claude Code");
    assert.equal(result.missing[0].expected, "CLAUDE.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("should detect Cursor via .cursor/ dir", () => {
    mkdirSync(join(tmpDir, ".cursor"), { recursive: true });
    writeFileSync(join(tmpDir, ".cursorrules"), "rules\n");
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "Cursor"));
    assert.ok(result.files.includes(".cursorrules"));
  });

  it("should detect Codex via AGENTS.md file", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Test\n");
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "OpenAI Codex"));
    assert.ok(result.files.includes("AGENTS.md"));
  });

  it("should detect Copilot via instruction file", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github/copilot-instructions.md"),
      "# Copilot\n",
    );
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "GitHub Copilot"));
    assert.ok(result.files.includes(".github/copilot-instructions.md"));
  });

  it("should detect Windsurf via .windsurf/ dir and find .windsurfrules", () => {
    mkdirSync(join(tmpDir, ".windsurf"), { recursive: true });
    writeFileSync(join(tmpDir, ".windsurfrules"), "rules\n");
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "Windsurf"));
    assert.ok(result.files.includes(".windsurfrules"));
  });

  it("should error when Windsurf detected but .windsurfrules missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-lint-windsurf-"));
    mkdirSync(join(dir, ".windsurf"), { recursive: true });
    const result = discoverInstructionFiles(dir);
    assert.ok(result.detected.some((d) => d.name === "Windsurf"));
    assert.ok(result.missing.some((m) => m.tool === "Windsurf"));
    assert.equal(
      result.missing.find((m) => m.tool === "Windsurf").expected,
      ".windsurfrules",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("should detect Cline via .clinerules file", () => {
    writeFileSync(join(tmpDir, ".clinerules"), "rules\n");
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.some((d) => d.name === "Cline"));
    assert.ok(result.files.includes(".clinerules"));
  });

  it("should error when Cline explicitly required but .clinerules missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-lint-cline-"));
    const result = discoverInstructionFiles(dir, ["Cline"]);
    assert.ok(result.detected.some((d) => d.name === "Cline"));
    assert.ok(result.missing.some((m) => m.tool === "Cline"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("should detect multiple tools at once", () => {
    const result = discoverInstructionFiles(tmpDir);
    assert.ok(result.detected.length >= 4);
    assert.ok(result.files.length >= 4);
  });

  it("should check explicit agents list even without indicators", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-lint-discover3-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# Test\n");
    // No .cursor/ dir, but explicitly request Cursor check
    const result = discoverInstructionFiles(dir, ["Claude Code", "Cursor"]);
    assert.ok(result.detected.some((d) => d.name === "Claude Code"));
    assert.ok(result.detected.some((d) => d.name === "Cursor"));
    assert.ok(result.files.includes("CLAUDE.md"));
    // Cursor detected but .cursorrules missing
    assert.ok(result.missing.some((m) => m.tool === "Cursor"));
    rmSync(dir, { recursive: true, force: true });
  });
});
