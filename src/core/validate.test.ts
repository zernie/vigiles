import { describe, it, beforeAll as before, afterAll as after } from "vitest";
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
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { vigilesConfigSchema, formatConfigIssues } from "./config-schema.js";
import type { MarkerType, ParseOptions } from "./types.js";

describe("config value normalization (now the schema's job)", () => {
  /**
   * The ESLint idioms are the reason `normalizeSeverity` existed (#112: `"off"`
   * is a truthy string and rendered as a WARN, so a disabled rule kept gating).
   * Same inputs, same outputs — the transform simply lives in the schema now, so
   * it cannot be skipped by a reader that forgets to call it.
   */
  it("parses the ESLint severity idioms into real decisions", () => {
    const sev = (v: unknown): unknown =>
      vigilesConfigSchema.parse({ rules: { integrity: v } }).rules.integrity;
    assert.equal(sev("off"), false);
    assert.equal(sev(0), false);
    assert.equal(sev(1), "warn");
    assert.equal(sev(2), "error");
    assert.equal(sev("warn"), "warn");
    assert.equal(sev("error"), "error");
    assert.equal(sev(false), false);
  });

  it("parses the [severity, options] form, mapping the head", () => {
    assert.deepEqual(
      vigilesConfigSchema.parse({
        rules: { "untested-skill": ["error", { testExtension: ".t.ts" }] },
      }).rules["untested-skill"],
      ["error", { testExtension: ".t.ts" }],
    );
  });

  /**
   * 🔴 THE ONE DELIBERATE BEHAVIOUR CHANGE, and it is the direction #112 asked
   * for. `normalizeSeverity("bogus")` used to return `"bogus"` — "left as-is,
   * pre-existing behavior" — which downstream rendered as a warn. A misspelled
   * severity now FAILS, with the accepted values named.
   */
  it("REFUSES an unrecognized severity instead of rendering it as a warn", () => {
    const r = vigilesConfigSchema.safeParse({ rules: { integrity: "bogus" } });
    assert.equal(r.success, false);
    assert.deepEqual(formatConfigIssues(r.error.issues), [
      ".vigilesrc.json: rules.integrity is not one of the accepted values " +
        '("warn", "error", false, "off", 0, 1, 2, true).',
    ]);
  });

  it("accepts a bare string as a one-element list, never char-by-char", () => {
    // C3/C4: `"exclude": "bench/**"` must not spread into ["b","e","n",…].
    assert.deepEqual(
      vigilesConfigSchema.parse({ exclude: "bench/**" }).exclude,
      ["bench/**"],
    );
    assert.deepEqual(
      vigilesConfigSchema.parse({ exclude: ["a", "b"] }).exclude,
      ["a", "b"],
    );
  });

  it("REFUSES a non-string entry instead of silently dropping it", () => {
    // The old `asStringArray(["a", 2, "b"])` returned ["a","b"] — the 2 vanished
    // with no word said, which is the same silence the schema exists to end.
    const r = vigilesConfigSchema.safeParse({ exclude: ["a", 2, "b"] });
    assert.equal(r.success, false);
  });
});

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
      { rules: { "require-instructions-spec": false } },
    );
    assert.equal(result.enforced, 1);
    assert.equal(result.guidanceOnly, 1);
    assert.equal(result.missing, 1);
    assert.equal(result.total, 3);
  });

  it("should be valid with no errors when require-instructions-spec is off", () => {
    const result = validate("### Rule\n**Enforced by:** `x`\n", {
      rules: { "require-instructions-spec": false },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// require-instructions-spec rule
// ---------------------------------------------------------------------------

describe("require-instructions-spec", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-require-instructions-spec-"));
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
      rules: { "require-instructions-spec": "error" },
    });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
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
      rules: { "require-instructions-spec": "error" },
    });
    assert.ok(
      !result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
  });

  it("should be disabled via HTML comment", () => {
    const subDir = join(tmpDir, "disabled");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(
      mdPath,
      "<!-- vigiles-disable require-instructions-spec -->\n# Test\n",
    );

    const result = validate(
      "<!-- vigiles-disable require-instructions-spec -->\n# Test\n",
      {
        filePath: mdPath,
        rules: { "require-instructions-spec": "error" },
      },
    );
    assert.ok(
      !result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
  });

  it("should be disabled via config", () => {
    const subDir = join(tmpDir, "config-off");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-instructions-spec": false },
    });
    assert.ok(
      !result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
  });

  it("should not run when filePath is not provided", () => {
    const result = validate("# Test\n", {
      rules: { "require-instructions-spec": "error" },
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
    assert.ok(
      result.warnings.some((e) => e.rule === "require-instructions-spec"),
    );
    assert.equal(result.errors.length, 0);
  });

  it("should error when severity is 'error'", () => {
    const subDir = join(tmpDir, "error-mode");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "CLAUDE.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-instructions-spec": "error" },
    });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
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

  it("should not fire require-instructions-spec on SKILL.md", () => {
    const subDir = join(tmpDir, "skill-no-spec");
    mkdirSync(subDir, { recursive: true });
    const mdPath = join(subDir, "SKILL.md");
    writeFileSync(mdPath, "# Test\n");

    const result = validate("# Test\n", {
      filePath: mdPath,
      rules: { "require-instructions-spec": "error" },
    });
    // require-instructions-spec only applies to CLAUDE.md/AGENTS.md
    assert.ok(
      !result.errors.some((e) => e.rule === "require-instructions-spec"),
    );
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
      // Both were untierable until 2026-09 — they fed the exit code with no rule
      // id to address them (#181). Registered as real rules, they land at "warn"
      // like every other heuristic proxy.
      "spec-refs": "error",
      "orphan-docs": "warn",
      "duplicate-rules": "warn",
      "require-instructions-spec": "warn",
      // the consistent require-<surface>-spec parallel → default off
      "require-skill-spec": false,
      integrity: "warn",
      coverage: false,
      "untested-skill": "warn",
      "untested-subagent": "warn",
      "untested-hook": "warn",
      "unmarked-refs": "warn",
      "subagent-tool-contract": "warn",
      "hook-events": "warn",
      "subagent-frontmatter": "warn",
      "mcp-config": "warn",
      "skill-frontmatter": "warn",
      "mcp-tool-resolves": "warn",
      "hook-script-exists": "warn",
      // nudge-group recommendation → default off (opt in to surface it)
      "prefer-compiled-hooks": false,
      "disallowed-tools-contract": "warn",
      "description-overlap": "warn",
      "skill-description-budget": "warn",
      "frontmatter-valid": "warn",
      "mcp-hook-target-resolves": "warn",
      "lethal-trifecta": "warn",
      "skill-resource-resolves": "warn",
      "skill-missing-fence": "warn",
      "plugin-dir-layout": "warn",
      "delegation-trifecta": "warn",
      "hook-block-ineffective": "warn",
      "hook-matcher": "warn",
      // Off by measurement: 0 true positives over 2 582 markdown files.
      "doc-refs": false,
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

  it("should allow disabling require-instructions-spec via config", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "require-instructions-spec": false } }),
    );
    process.chdir(configDir);
    const config = loadConfig();
    assert.equal(config.rules["require-instructions-spec"], false);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  /**
   * 🔴 A DELIBERATE BEHAVIOUR CHANGE, and the direction is the point.
   *
   * This used to read `{"ruleMarkers": ["invalid"]}`, print a `console.warn`,
   * and silently use the defaults — so a repo that asked for something the tool
   * does not support got the tool's own answer with no consequence. The same
   * silence one key over (`surfaceRootz`) is what #240 measured. It is now a
   * named refusal at the verb, and a WARNING plus the defaults on a hook rail,
   * which is the one distinction the two readers are allowed to make.
   */
  it("REFUSES an invalid ruleMarkers value instead of quietly defaulting", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ ruleMarkers: ["invalid"] }),
    );
    process.chdir(configDir);
    assert.throws(
      () => loadConfig(),
      /ruleMarkers\.0 .*expected one of "headings"\|"checkboxes"/,
    );
    // The hook-rail reading of the SAME file: warn, then carry on. Asserted
    // beside the throw, because "validation runs everywhere" and "a bad config
    // may kill a hook" are different claims and only the first is true.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.join(" "));
    try {
      assert.deepEqual(
        loadConfig(undefined, { onInvalid: "warn" }).ruleMarkers,
        ["headings", "checkboxes"],
      );
    } finally {
      console.warn = realWarn;
    }
    assert.match(warned.join("\n"), /ruleMarkers\.0/);
    assert.match(warned.join("\n"), /Using default configuration/);
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  /**
   * 🔴 THE REPLACED KEYS FAIL LOUDLY AND NAME THE NEW SHAPE (#240).
   *
   * There is no alias and no deprecation window, on purpose: both old keys could
   * be honoured only by picking ONE layout for a global root list, which IS the
   * defect. A config that kept working would keep the defect with it.
   */
  it("refuses the replaced `harness` / `surfaceRoots` keys, naming the new one", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({ harness: ["claude-code"], surfaceRoots: [".ai"] }),
    );
    process.chdir(configDir);
    assert.throws(loadConfig, (e: Error) => {
      assert.match(e.message, /"harness" and "surfaceRoots" were replaced/);
      assert.match(
        e.message,
        /"harnesses": \{ "claude-code": \{ "roots": \[".ai"\] \}/,
      );
      assert.match(e.message, /order silently decided what got read/);
      return true;
    });
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  /** The same file in the new shape loads — so the test above is not just "any config throws". */
  it("accepts the shape that replaced them", () => {
    const configDir = mkdtempSync(join(tmpdir(), "vigiles-config-"));
    writeFileSync(
      join(configDir, ".vigilesrc.json"),
      JSON.stringify({
        harnesses: { "claude-code": { roots: [".ai"] }, codex: {} },
      }),
    );
    process.chdir(configDir);
    assert.deepEqual(loadConfig().harnesses, {
      "claude-code": { roots: [".ai"] },
      codex: {},
    });
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
      rules: { "require-instructions-spec": false },
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
      rules: { "require-instructions-spec": false },
    });
    assert.equal(valid, false);
  });

  it("should skip symlinks by default but not fail", () => {
    const real = join(tmpDir, "real3.md");
    const link = join(tmpDir, "link3.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([real, link], {
      rules: { "require-instructions-spec": false },
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
      rules: { "require-instructions-spec": false },
    });
    assert.equal(valid, true);
    assert.equal(fileResults[0].skipped, false);
    assert.notEqual(fileResults[0].result, null);
    assert.equal(fileResults[0].result?.enforced, 1);
  });

  it("dedupes a symlinked mirror — validates the real file once (req 7)", () => {
    // CLAUDE.md (real) + AGENTS.md → CLAUDE.md, both passed. The mirror is
    // recognized and skipped with a 'mirror' reason, not double-validated.
    const real = join(tmpDir, "CLAUDE.md");
    const link = join(tmpDir, "AGENTS.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([real, link], {
      rules: { "require-instructions-spec": false },
    });
    assert.equal(valid, true);
    assert.equal(fileResults[0].skipped, false); // real validated
    assert.equal(fileResults[1].skipped, true); // mirror skipped
    assert.match(fileResults[1].reason ?? "", /mirror of/);
  });

  it("real file still validates when the symlink is listed first (no shadowing)", () => {
    // Symlink first: it must NOT record itself as canonical and shadow the real
    // file that follows — the real CLAUDE.md must still be validated.
    const real = join(tmpDir, "CLAUDE2.md");
    const link = join(tmpDir, "AGENTS2.md");
    writeFileSync(real, "### Rule\n**Enforced by:** `x`\n");
    symlinkSync(real, link);

    const { fileResults, valid } = validatePaths([link, real], {
      rules: { "require-instructions-spec": false },
    });
    assert.equal(valid, true);
    // The symlink (listed first) is skipped by default but must NOT shadow the
    // real file — exactly one file is validated, and it's the real one.
    const validated = fileResults.filter((r) => !r.skipped);
    assert.equal(validated.length, 1);
    assert.equal(validated[0].path, real);
    assert.equal(validated[0].result?.enforced, 1);
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

describe("which filenames count as an instruction file — the dialect decides", () => {
  // 🔴 THE ONE CONSUMER `instructionTargets` GAINING `AGENTS.md` ACTUALLY MOVED,
  // measured before the edit and asserted after it. Injecting the Claude Code
  // dialect used to make vigiles recognise FEWER instruction files than its own
  // no-dialect default: an `AGENTS.md` came back with zero findings under the CC
  // dialect and `require-instructions-spec` without one. Since v2.1.277 Claude
  // Code really does read `AGENTS.md`, so the narrower answer was the wrong one.
  const rulesOf = (opts: Parameters<typeof validate>[1]): string[] => {
    const r = validate("# x\n", opts);
    return [...r.errors, ...r.warnings].map((e) => e.rule);
  };

  it("an AGENTS.md is an instruction file under the Claude Code dialect", () => {
    assert.deepEqual(
      rulesOf({
        filePath: join(tmpdir(), "no-such-dir-vigiles", "AGENTS.md"),
        dialect: claudeCodeDialect,
      }),
      ["require-instructions-spec"],
    );
  });

  it("…the same answer the no-dialect default already gave", () => {
    // The pair is the point: one of these alone would pass with the two
    // answers still disagreeing, which is exactly the state this fixed.
    assert.deepEqual(
      rulesOf({ filePath: join(tmpdir(), "no-such-dir-vigiles", "AGENTS.md") }),
      ["require-instructions-spec"],
    );
  });

  it("and an ordinary markdown file is still NOT one", () => {
    // The other half. A dialect that recognised everything would make the rule
    // fire on every README in the repository.
    assert.deepEqual(
      rulesOf({
        filePath: join(tmpdir(), "no-such-dir-vigiles", "NOTES.md"),
        dialect: claudeCodeDialect,
      }),
      [],
    );
  });
});
