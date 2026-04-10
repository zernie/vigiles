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
  parseRules,
  readInstructionFile,
  validatePaths,
  expandGlobs,
  findInstructionFiles,
  loadConfig,
} from "./validate.js";
import type { MarkerType, ParseOptions } from "./types.js";

// ---------------------------------------------------------------------------
// parseRules
// ---------------------------------------------------------------------------

describe("parseRules", () => {
  it("should parse enforced rules", () => {
    const rules = parseRules(
      "### Use barrel imports\n**Enforced by:** `eslint/no-restricted-imports`\n**Why:** Consistency.\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Use barrel imports");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[0].enforcedBy, "eslint/no-restricted-imports");
  });

  it("should parse guidance-only rules", () => {
    const rules = parseRules(
      "### Use Tailwind spacing scale\n**Guidance only** — cannot be mechanically enforced\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "guidance");
  });

  it("should parse rules missing annotations", () => {
    const rules = parseRules("### Some rule\n**Why:** Just because.\n");
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "missing");
  });

  it("should track line numbers", () => {
    const rules = parseRules(
      "# Header\n\nSome text\n\n### First rule\n**Enforced by:** `x`\n\n### Second rule\nNo annotation\n",
    );
    assert.equal(rules[0].line, 5);
    assert.equal(rules[1].line, 8);
  });

  it("should handle multiple rules in sequence", () => {
    const rules = parseRules(
      "### Rule A\n**Enforced by:** `a`\n### Rule B\n**Guidance only**\n### Rule C\nNothing here.\n",
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].enforcement, "missing");
  });

  it("should not match deeper headings (####)", () => {
    const rules = parseRules(
      "### Real rule\n**Enforced by:** `x`\n#### Not a rule\nSome details.\n",
    );
    assert.equal(rules.length, 1);
  });

  it("should not match shallower headings (## or #)", () => {
    const rules = parseRules(
      "# Top level\n## Section\n### Actual rule\n**Enforced by:** `x`\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Actual rule");
  });

  it("should handle empty file", () => {
    const rules = parseRules("");
    assert.equal(rules.length, 0);
  });

  it("should handle file with no rules", () => {
    const rules = parseRules("# CLAUDE.md\n\nThis project uses TypeScript.\n");
    assert.equal(rules.length, 0);
  });

  it("should stop looking for annotation at next header", () => {
    const rules = parseRules(
      "### Rule A\nSome text.\nMore text.\n### Rule B\n**Enforced by:** `x`\n",
    );
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("should parse disabled rules", () => {
    const rules = parseRules(
      "### Skipped rule\n<!-- vigiles-disable -->\n**Why:** Not relevant here.\n",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "disabled");
  });

  it("should handle vigiles-disable with extra whitespace", () => {
    const rules = parseRules("### Skipped rule\n<!--  vigiles-disable  -->\n");
    assert.equal(rules[0].enforcement, "disabled");
  });
});

// ---------------------------------------------------------------------------
// parseRules with checkboxes
// ---------------------------------------------------------------------------

describe("parseRules with checkboxes", () => {
  const opts: ParseOptions = { ruleMarkers: ["checkboxes"] };
  const bothOpts: ParseOptions = { ruleMarkers: ["headings", "checkboxes"] };

  it("should parse unchecked checkbox with enforced annotation", () => {
    const rules = parseRules(
      "- [ ] Use barrel imports\n**Enforced by:** `eslint/no-restricted-imports`\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Use barrel imports");
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[0].enforcedBy, "eslint/no-restricted-imports");
  });

  it("should parse checked checkbox (lowercase x) with guidance", () => {
    const rules = parseRules(
      "- [x] Use Tailwind spacing\n**Guidance only** — cannot be enforced\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "guidance");
  });

  it("should parse checked checkbox (uppercase X) with disabled", () => {
    const rules = parseRules(
      "- [X] Skipped rule\n<!-- vigiles-disable -->\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "disabled");
  });

  it("should detect checkbox rule missing annotation", () => {
    const rules = parseRules("- [ ] Some rule\nJust a description.\n", opts);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].enforcement, "missing");
  });

  it("should handle multiple checkboxes in sequence", () => {
    const rules = parseRules(
      "- [ ] Rule A\n**Enforced by:** `a`\n- [x] Rule B\n**Guidance only**\n- [ ] Rule C\nNothing.\n",
      opts,
    );
    assert.equal(rules.length, 3);
    assert.equal(rules[0].enforcement, "enforced");
    assert.equal(rules[1].enforcement, "guidance");
    assert.equal(rules[2].enforcement, "missing");
  });

  it("should track line numbers for checkbox rules", () => {
    const rules = parseRules(
      "# Header\n\nSome text\n\n- [ ] First rule\n**Enforced by:** `x`\n\n- [ ] Second rule\nNo annotation\n",
      opts,
    );
    assert.equal(rules[0].line, 5);
    assert.equal(rules[1].line, 8);
  });

  it("should not match indented checkboxes", () => {
    const rules = parseRules(
      "  - [ ] Indented item\n**Enforced by:** `x`\n",
      opts,
    );
    assert.equal(rules.length, 0);
  });

  it("should handle mixed headers and checkboxes with both markers", () => {
    const rules = parseRules(
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
    const rules = parseRules(
      "### Rule A\nSome text\n- [ ] Rule B\n**Enforced by:** `x`\n",
      bothOpts,
    );
    assert.equal(rules[0].title, "Rule A");
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].title, "Rule B");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("heading should flush previous checkbox rule", () => {
    const rules = parseRules(
      "- [ ] Rule A\nSome text\n### Rule B\n**Enforced by:** `x`\n",
      bothOpts,
    );
    assert.equal(rules[0].title, "Rule A");
    assert.equal(rules[0].enforcement, "missing");
    assert.equal(rules[1].title, "Rule B");
    assert.equal(rules[1].enforcement, "enforced");
  });

  it("should ignore checkboxes when only headings marker is enabled", () => {
    const rules = parseRules(
      "- [ ] Checkbox rule\n**Enforced by:** `x`\n### Heading rule\n**Enforced by:** `y`\n",
      { ruleMarkers: ["headings"] as MarkerType[] },
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Heading rule");
  });

  it("should ignore headings when only checkboxes marker is enabled", () => {
    const rules = parseRules(
      "### Heading rule\n**Enforced by:** `x`\n- [ ] Checkbox rule\n**Enforced by:** `y`\n",
      opts,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "Checkbox rule");
  });
});

// ---------------------------------------------------------------------------
// validate — core
// ---------------------------------------------------------------------------

describe("validate", () => {
  it("should count enforced, guidance, and missing rules", () => {
    const result = validate(
      "### Rule A\n**Enforced by:** `x`\n### Rule B\n**Guidance only**\n### Rule C\nNothing.\n",
      { rules: { "require-spec": false } },
    );
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 1);
    assert.equal(result.total, 3);
  });

  it("should be valid with no errors when require-spec is off", () => {
    const result = validate("### Rule\n**Enforced by:** `x`\n", {
      rules: { "require-spec": false },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// require-spec rule
// ---------------------------------------------------------------------------

describe("require-spec", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-require-spec-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should error when no .spec.ts file exists", () => {
    const subDir = join(tmpDir, "no-spec");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# CLAUDE.md\n### Rule\n**Enforced by:** `x`\n");

    const result = validate("# CLAUDE.md\n### Rule\n**Enforced by:** `x`\n", {
      filePath: mdPath,
      rules: { "require-spec": "error" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "require-spec"));
    assert.ok(result.errors[0].message.includes("No spec file"));
  });

  it("should pass when .spec.ts file exists", () => {
    const subDir = join(tmpDir, "has-spec");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    const specPath = join(subDir, "CLAUDE.md.spec.ts");
    writeFileSync(mdPath, "# Test\n");
    writeFileSync(specPath, "export default {};\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-spec": "error" },
    });
    assert.ok(!result.errors.some((e) => e.rule === "require-spec"));
  });

  it("should be disabled via HTML comment", () => {
    const subDir = join(tmpDir, "disabled");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "<!-- vigiles-disable require-spec -->\n# Test\n");

    const result = validate("<!-- vigiles-disable require-spec -->\n# Test\n", {
      filePath: mdPath,
      rules: { "require-spec": "error" },
    });
    assert.ok(!result.errors.some((e) => e.rule === "require-spec"));
  });

  it("should be disabled via config", () => {
    const subDir = join(tmpDir, "config-off");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-spec": false },
    });
    assert.ok(!result.errors.some((e) => e.rule === "require-spec"));
  });

  it("should not run when filePath is not provided", () => {
    const result = validate("# Test\n", {
      rules: { "require-spec": "error" },
    });
    assert.equal(result.valid, true);
  });

  it("should warn by default (not error)", () => {
    const subDir = join(tmpDir, "warn-default");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Test\n");

    // Default is "warn" — valid stays true, warning emitted
    const result = validate("# Test\n", { filePath: mdPath });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((e) => e.rule === "require-spec"));
    assert.equal(result.errors.length, 0);
  });

  it("should error when severity is 'error'", () => {
    const subDir = join(tmpDir, "error-mode");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-spec": "error" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "require-spec"));
  });

  it("should warn for SKILL.md when require-skill-spec is warn", () => {
    const subDir = join(tmpDir, "skill-warn");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "SKILL.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-skill-spec": "warn" },
    });
    assert.ok(result.warnings.some((e) => e.rule === "require-skill-spec"));
    assert.equal(result.valid, true);
  });

  it("should not fire require-spec on SKILL.md", () => {
    const subDir = join(tmpDir, "skill-no-spec");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "SKILL.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-spec": "error" },
    });
    // require-spec only applies to CLAUDE.md/AGENTS.md
    assert.ok(!result.errors.some((e) => e.rule === "require-spec"));
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

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
      "require-spec": "warn",
      "require-skill-spec": "warn",
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

  it("should allow disabling require-spec via config", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "require-spec": false } }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["require-spec"], false);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
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
});

// ---------------------------------------------------------------------------
// readInstructionFile
// ---------------------------------------------------------------------------

describe("readInstructionFile", () => {
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
    const { content, skipped } = readInstructionFile(filePath);
    assert.equal(skipped, false);
    assert.notEqual(content, null);
    assert.ok((content as string).includes("### Rule"));
  });

  it("should return error for missing file", () => {
    const { content, skipped, reason } = readInstructionFile(
      join(tmpDir, "nope.md"),
    );
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
    const { content, skipped, reason } = readInstructionFile(link);
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
    const { content, skipped } = readInstructionFile(link, {
      followSymlinks: true,
    });
    assert.equal(skipped, false);
    assert.notEqual(content, null);
    assert.ok((content as string).includes("### Rule"));
  });
});

// ---------------------------------------------------------------------------
// validatePaths
// ---------------------------------------------------------------------------

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

    const { fileResults, valid } = validatePaths([file1, file2], {
      rules: { "require-spec": false },
    });
    assert.equal(valid, true);
    assert.equal(fileResults.length, 2);
    assert.notEqual(fileResults[0].result, null);
    assert.equal(fileResults[0].result?.enforced, 1);
    assert.notEqual(fileResults[1].result, null);
    assert.equal(fileResults[1].result?.guidanceOnly, 1);
  });

  it("should fail if any file is missing", () => {
    const file1 = join(tmpDir, "exists.md");
    writeFileSync(file1, "### Rule\n**Enforced by:** `x`\n");

    const { valid } = validatePaths([file1, join(tmpDir, "missing.md")], {
      rules: { "require-spec": false },
    });
    assert.equal(valid, false);
  });

  it("should skip symlinks by default but not fail", () => {
    const real = join(tmpDir, "real3.md");
    const link = join(tmpDir, "link3.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([real, link], {
      rules: { "require-spec": false },
    });
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
      rules: { "require-spec": false },
    });
    assert.equal(valid, true);
    assert.equal(fileResults[0].skipped, false);
    assert.notEqual(fileResults[0].result, null);
    assert.equal(fileResults[0].result?.enforced, 1);
  });
});

// ---------------------------------------------------------------------------
// expandGlobs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// findInstructionFiles
// ---------------------------------------------------------------------------

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
