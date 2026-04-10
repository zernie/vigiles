import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  enforce,
  guidance,
  check,
  every,
  file,
  cmd,
  ref,
  instructions,
  claude,
  skill,
} from "./spec.js";

import {
  compileClaude,
  compileSkill,
  computeHash,
  addHash,
  verifyHash,
  checkFileHash,
  estimateTokens,
  executeAssertion,
  executeChecks,
  adoptDiff,
} from "./compile.js";

import { generateTypes } from "./generate-types.js";
import { checkLinterRule } from "./linters.js";

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Builder tests
// ---------------------------------------------------------------------------

describe("enforce()", () => {
  it("creates an enforce rule", () => {
    const rule = enforce("eslint/no-console", "Use structured logger.");
    assert.equal(rule._kind, "enforce");
    assert.equal(rule.linterRule, "eslint/no-console");
    assert.equal(rule.why, "Use structured logger.");
  });

  it("accepts scoped plugins", () => {
    const rule = enforce(
      "@typescript-eslint/no-explicit-any",
      "Degrades type safety.",
    );
    assert.equal(rule.linterRule, "@typescript-eslint/no-explicit-any");
  });

  it("accepts all supported linters", () => {
    const linters = [
      "eslint/no-console",
      "ruff/T201",
      "clippy/unwrap_used",
      "pylint/C0114",
      "rubocop/Style/FrozenStringLiteral",
      "stylelint/color-no-invalid-hex",
    ] as const;
    for (const linter of linters) {
      const rule = enforce(linter, "test");
      assert.equal(rule._kind, "enforce");
    }
  });
});

describe("guidance()", () => {
  it("creates a guidance rule", () => {
    const rule = guidance("Google unfamiliar APIs first.");
    assert.equal(rule._kind, "guidance");
    assert.equal(rule.text, "Google unfamiliar APIs first.");
  });
});

describe("check()", () => {
  it("creates a file-pairing check", () => {
    const rule = check(
      every("src/**/*.controller.ts").has("{name}.test.ts"),
      "Every controller needs tests.",
    );
    assert.equal(rule._kind, "check");
    assert.equal(rule.assertion._type, "file-pairing");
    assert.equal(rule.assertion.glob, "src/**/*.controller.ts");
    assert.equal(rule.assertion.pattern, "{name}.test.ts");
  });
});

describe("reference helpers", () => {
  it("file() creates a file ref", () => {
    const r = file("src/validate.ts");
    assert.equal(r._ref, "file");
    assert.equal(r.path, "src/validate.ts");
  });

  it("cmd() creates a cmd ref", () => {
    const r = cmd("npm test");
    assert.equal(r._ref, "cmd");
    assert.equal(r.command, "npm test");
  });

  it("ref() creates a skill ref", () => {
    const r = ref("skills/other/SKILL.md");
    assert.equal(r._ref, "skill");
    assert.equal(r.path, "skills/other/SKILL.md");
  });
});

describe("instructions tagged template", () => {
  it("interleaves strings and refs", () => {
    const result = instructions`Check ${file("foo.ts")} and run ${cmd("npm test")}.`;
    assert.equal(result.length, 5);
    assert.equal(typeof result[0], "string");
    assert.equal((result[1] as { _ref: string })._ref, "file");
    assert.equal(typeof result[2], "string");
    assert.equal((result[3] as { _ref: string })._ref, "cmd");
    assert.equal(typeof result[4], "string");
  });
});

describe("claude()", () => {
  it("creates a claude spec with correct type tag", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    assert.equal(spec._specType, "claude");
    assert.ok(spec.rules["no-console"]);
  });
});

describe("skill()", () => {
  it("creates a skill spec with correct type tag", () => {
    const spec = skill({
      name: "test-skill",
      description: "A test skill",
      body: "Do the thing.",
    });
    assert.equal(spec._specType, "skill");
    assert.equal(spec.name, "test-skill");
  });
});

// ---------------------------------------------------------------------------
// Compiler tests
// ---------------------------------------------------------------------------

describe("compileClaude()", () => {
  it("compiles a minimal spec to markdown", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use structured logger."),
        "research-first": guidance("Google unfamiliar APIs first."),
      },
    });
    const { markdown, errors } = compileClaude(spec);
    assert.ok(markdown.includes("<!-- vigiles:sha256:"));
    assert.ok(markdown.includes("# CLAUDE.md"));
    assert.ok(markdown.includes("### No Console"));
    assert.ok(markdown.includes("**Enforced by:** `eslint/no-console`"));
    assert.ok(markdown.includes("**Why:** Use structured logger."));
    assert.ok(markdown.includes("### Research First"));
    assert.ok(
      markdown.includes("**Guidance only** — Google unfamiliar APIs first."),
    );
    assert.equal(errors.length, 0);
  });

  it("includes commands section", () => {
    const spec = claude({
      commands: { "npm test": "Run tests" },
      rules: {},
    });
    const { markdown } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("## Commands"));
    assert.ok(markdown.includes("`npm test` — Run tests"));
  });

  it("includes key files section", () => {
    const spec = claude({
      keyFiles: { "src/spec.ts": "Spec system" },
      rules: {},
    });
    const { markdown } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("## Key Files"));
    assert.ok(markdown.includes("`src/spec.ts` — Spec system"));
  });

  it("reports errors for missing key files", () => {
    const spec = claude({
      keyFiles: { "src/nonexistent-file-xyz.ts": "Does not exist" },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });

  it("reports errors for missing npm scripts", () => {
    const spec = claude({
      commands: { "npm run nonexistent-script-xyz": "Does not exist" },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-command");
  });

  it("includes sections in output", () => {
    const spec = claude({
      sections: {
        architecture: "TypeScript strict-mode codebase.",
      },
      rules: {},
    });
    const { markdown } = compileClaude(spec);
    assert.ok(markdown.includes("## Architecture"));
    assert.ok(markdown.includes("TypeScript strict-mode codebase."));
  });

  it("compiles check rules with assertion description", () => {
    const spec = claude({
      rules: {
        "test-pairing": check(
          every("src/**/*.ts").has("{name}.test.ts"),
          "Every source needs tests.",
        ),
      },
    });
    const { markdown } = compileClaude(spec);
    assert.ok(markdown.includes("**Enforced by:** `vigiles/test-pairing`"));
    assert.ok(markdown.includes("**Check:**"));
  });

  it("enforces maxRules limit", () => {
    const rules: Record<string, ReturnType<typeof guidance>> = {};
    for (let i = 0; i < 5; i++) {
      rules[`rule-${String(i)}`] = guidance("test");
    }
    const spec = claude({ rules });
    const { errors } = compileClaude(spec, { maxRules: 3 });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("exceeds maxRules"));
  });

  it("returns linterResults for enforce rules", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    // eslint is installed in this project, so this should work
    const { linterResults } = compileClaude(spec, { basePath: process.cwd() });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].linter, "eslint");
    assert.equal(linterResults[0].rule, "no-console");
    assert.equal(linterResults[0].exists, true);
  });
});

describe("compileSkill()", () => {
  it("compiles a skill with string body", () => {
    const spec = skill({
      name: "test-skill",
      description: "A test skill",
      body: "Do the thing.\n\n## Step 1\nDo step 1.",
    });
    const { markdown, errors } = compileSkill(spec);
    assert.ok(markdown.includes("<!-- vigiles:sha256:"));
    assert.ok(markdown.includes("---\nname: test-skill\n"));
    assert.ok(markdown.includes("description: A test skill"));
    assert.ok(markdown.includes("Do the thing."));
    assert.equal(errors.length, 0);
  });

  it("compiles a skill with tagged template body", () => {
    const spec = skill({
      name: "test-skill",
      description: "A test skill",
      body: instructions`Check ${file("package.json")} and run ${cmd("npm test")}.`,
    });
    const { markdown } = compileSkill(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("`package.json`"));
    assert.ok(markdown.includes("`npm test`"));
  });

  it("reports errors for missing file refs in body", () => {
    const spec = skill({
      name: "test-skill",
      description: "A test skill",
      body: instructions`Check ${file("nonexistent-xyz.ts")}.`,
    });
    const { errors } = compileSkill(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });

  it("includes frontmatter fields", () => {
    const spec = skill({
      name: "my-skill",
      description: "My skill desc",
      disableModelInvocation: true,
      argumentHint: "<some arg>",
      body: "Instructions here.",
    });
    const { markdown } = compileSkill(spec);
    assert.ok(markdown.includes("disable-model-invocation: true"));
    assert.ok(markdown.includes("argument-hint: <some arg>"));
  });
});

// ---------------------------------------------------------------------------
// Hash tests
// ---------------------------------------------------------------------------

describe("hash utilities", () => {
  it("computeHash is deterministic", () => {
    const a = computeHash("hello world");
    const b = computeHash("hello world");
    assert.equal(a, b);
  });

  it("computeHash differs for different content", () => {
    const a = computeHash("hello");
    const b = computeHash("world");
    assert.notEqual(a, b);
  });

  it("addHash + verifyHash roundtrips", () => {
    const content = "# CLAUDE.md\nSome content.\n";
    const hashed = addHash(content, "CLAUDE.md.spec.ts");
    const result = verifyHash(hashed);
    assert.ok(result);
    assert.equal(result.valid, true);
    assert.equal(result.specFile, "CLAUDE.md.spec.ts");
  });

  it("verifyHash detects tampering", () => {
    const content = "# CLAUDE.md\nOriginal content.\n";
    const hashed = addHash(content, "CLAUDE.md.spec.ts");
    const tampered = hashed.replace("Original content", "Modified content");
    const result = verifyHash(tampered);
    assert.ok(result);
    assert.equal(result.valid, false);
  });

  it("verifyHash returns null for files without hash", () => {
    const result = verifyHash("# Just a regular file.\n");
    assert.equal(result, null);
  });

  it("checkFileHash works on real files", () => {
    const tmpDir = join(process.cwd(), ".vigiles-test-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const content = "# Test\n";
      const hashed = addHash(content, "test.spec.ts");
      const filePath = join(tmpDir, "test.md");
      writeFileSync(filePath, hashed);

      const result = checkFileHash(filePath);
      assert.equal(result.hasHash, true);
      assert.equal(result.valid, true);
      assert.equal(result.specFile, "test.spec.ts");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("checkFileHash returns hasHash=false for nonexistent files", () => {
    const result = checkFileHash("/tmp/vigiles-nonexistent-file.md");
    assert.equal(result.hasHash, false);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Token estimation tests
// ---------------------------------------------------------------------------

describe("estimateTokens()", () => {
  it("estimates ~1 token per 4 chars", () => {
    const tokens = estimateTokens("a".repeat(100));
    assert.equal(tokens, 25);
  });

  it("rounds up", () => {
    const tokens = estimateTokens("abc");
    assert.equal(tokens, 1);
  });
});

// ---------------------------------------------------------------------------
// maxTokens tests
// ---------------------------------------------------------------------------

describe("maxTokens budget", () => {
  it("errors when compiled output exceeds maxTokens", () => {
    const spec = claude({
      sections: { prose: "x".repeat(1000) },
      rules: {},
    });
    const { errors, tokens } = compileClaude(spec, { maxTokens: 100 });
    assert.ok(tokens > 100);
    assert.ok(errors.some((e) => e.type === "budget-exceeded"));
  });

  it("passes when under budget", () => {
    const spec = claude({
      rules: { test: guidance("Short.") },
    });
    const { errors } = compileClaude(spec, { maxTokens: 10000 });
    assert.ok(!errors.some((e) => e.type === "budget-exceeded"));
  });
});

// ---------------------------------------------------------------------------
// Sections with file() refs
// ---------------------------------------------------------------------------

describe("sections with refs", () => {
  it("compiles sections with file() refs and validates them", () => {
    const spec = claude({
      sections: {
        architecture: instructions`Core engine in ${file("src/spec.ts")}.`,
      },
      rules: {},
    });
    const { markdown, errors } = compileClaude(spec, {
      basePath: process.cwd(),
    });
    assert.ok(markdown.includes("`src/spec.ts`"));
    assert.equal(errors.length, 0);
  });

  it("reports stale file refs in sections", () => {
    const spec = claude({
      sections: {
        architecture: instructions`See ${file("src/nonexistent-xyz.ts")}.`,
      },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });
});

// ---------------------------------------------------------------------------
// generate-types tests
// ---------------------------------------------------------------------------

describe("generateTypes()", () => {
  it("discovers eslint rules from this project", () => {
    const result = generateTypes({ basePath: process.cwd() });
    const eslint = result.linters.find((l) => l.linter === "eslint");
    assert.ok(eslint, "ESLint should be detected");
    assert.ok(eslint.rules.length > 0, "Should find enabled rules");
    assert.ok(
      eslint.rules.includes("no-unused-vars"),
      "Should include no-unused-vars",
    );
  });

  it("discovers npm scripts", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(result.scripts.includes("build"));
    assert.ok(result.scripts.includes("test"));
  });

  it("discovers project files", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(result.files.includes("src/spec.ts"));
    assert.ok(result.files.includes("src/compile.ts"));
  });

  it("generates valid .d.ts content", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(result.dts.includes('declare module "vigiles/generated"'));
    assert.ok(result.dts.includes("export type EslintRule"));
    assert.ok(result.dts.includes("export type NpmScript"));
    assert.ok(result.dts.includes("export type ProjectFile"));
  });

  it("respects custom file globs", () => {
    const result = generateTypes({
      basePath: process.cwd(),
      fileGlobs: ["examples/**/*"],
    });
    assert.ok(result.files.some((f) => f.startsWith("examples/")));
    assert.ok(!result.files.some((f) => f.startsWith("src/")));
  });

  it("generates syntactically valid .d.ts", () => {
    const result = generateTypes({ basePath: process.cwd() });

    // Write only the .d.ts and type-check it in isolation
    const tmpDir = join(process.cwd(), ".vigiles-test-types-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      writeFileSync(join(tmpDir, "generated.d.ts"), result.dts);
      writeFileSync(
        join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          include: ["generated.d.ts"],
        }),
      );

      const { execSync } =
        require("node:child_process") as typeof import("node:child_process");
      execSync("npx tsc --noEmit", {
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion execution tests
// ---------------------------------------------------------------------------

describe("executeAssertion()", () => {
  it("passes when paired files exist", () => {
    // src/spec.ts has src/spec.test.ts
    const result = executeAssertion(
      "test-pairing",
      { _type: "file-pairing", glob: "src/spec.ts", pattern: "{name}.test.ts" },
      process.cwd(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.total, 1);
    assert.equal(result.missing.length, 0);
  });

  it("fails when paired files are missing", () => {
    // src/cli.ts does NOT have src/cli.test.ts
    const result = executeAssertion(
      "test-pairing",
      { _type: "file-pairing", glob: "src/cli.ts", pattern: "{name}.test.ts" },
      process.cwd(),
    );
    assert.equal(result.passed, false);
    assert.equal(result.total, 1);
    assert.equal(result.missing.length, 1);
  });
});

describe("executeChecks()", () => {
  it("runs all check() rules from a spec", () => {
    const spec = claude({
      rules: {
        "has-test": check(
          every("src/spec.ts").has("{name}.test.ts"),
          "spec needs test",
        ),
        "no-console": enforce("eslint/no-console", "Use logger."),
        "be-nice": guidance("Be nice."),
      },
    });
    const results = executeChecks(spec, process.cwd());
    // Only check() rules are executed, not enforce() or guidance()
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "has-test");
    assert.equal(results[0].passed, true);
  });
});

// ---------------------------------------------------------------------------
// Linter integration tests (checkLinterRule)
// ---------------------------------------------------------------------------

describe("checkLinterRule()", () => {
  it("detects eslint built-in rules", () => {
    const result = checkLinterRule("eslint/no-console", process.cwd());
    assert.equal(result.exists, true);
    assert.equal(result.linter, "eslint");
    assert.equal(result.rule, "no-console");
  });

  it("errors on nonexistent eslint rule", () => {
    const result = checkLinterRule(
      "eslint/completely-fake-rule-xyz",
      process.cwd(),
    );
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("completely-fake-rule-xyz"));
  });

  it("detects ruff rules via CLI", () => {
    const result = checkLinterRule("ruff/E501", process.cwd());
    assert.equal(result.exists, true);
    assert.equal(result.linter, "ruff");
  });

  it("errors on nonexistent ruff rule", () => {
    const result = checkLinterRule("ruff/FAKE999", process.cwd());
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("FAKE999"));
  });

  it("detects clippy rules via CLI", () => {
    const result = checkLinterRule("clippy/needless_return", process.cwd());
    assert.equal(result.exists, true);
    assert.equal(result.linter, "clippy");
  });

  it("errors on nonexistent clippy lint", () => {
    const result = checkLinterRule(
      "clippy/completely_fake_lint_xyz",
      process.cwd(),
    );
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("completely_fake_lint_xyz"));
  });

  it("detects pylint rules via CLI", () => {
    const result = checkLinterRule("pylint/C0301", process.cwd());
    assert.equal(result.exists, true);
    assert.equal(result.linter, "pylint");
  });

  it("errors on nonexistent pylint rule", () => {
    const result = checkLinterRule("pylint/ZZZZ9999", process.cwd());
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("ZZZZ9999"));
  });

  it("detects rubocop cops via CLI", () => {
    const result = checkLinterRule(
      "rubocop/Style/FrozenStringLiteralComment",
      process.cwd(),
    );
    assert.equal(result.exists, true);
    assert.equal(result.linter, "rubocop");
  });

  it("errors on nonexistent rubocop cop", () => {
    const result = checkLinterRule(
      "rubocop/Fake/NonExistentCop",
      process.cwd(),
    );
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("Fake/NonExistentCop"));
  });

  it("rejects unsafe rule names", () => {
    const result = checkLinterRule(
      "eslint/no-console; rm -rf /",
      process.cwd(),
    );
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("Invalid rule reference"));
  });

  it("handles unknown linters gracefully", () => {
    const result = checkLinterRule("unknown-tool/some-rule", process.cwd());
    assert.equal(result.exists, false);
    assert.ok(result.error?.includes("Unknown linter"));
  });

  it("checks custom rulesDir", () => {
    const tmpDir = join(process.cwd(), ".vigiles-test-linter-tmp");
    const rulesDir = join(tmpDir, "my-rules");
    mkdirSync(rulesDir, { recursive: true });
    try {
      writeFileSync(join(rulesDir, "check-foo.js"), "module.exports = {};\n");

      const found = checkLinterRule("my-tool/check-foo", tmpDir, {
        linters: { "my-tool": { rulesDir: "my-rules" } },
      });
      assert.equal(found.exists, true);

      const missing = checkLinterRule("my-tool/check-bar", tmpDir, {
        linters: { "my-tool": { rulesDir: "my-rules" } },
      });
      assert.equal(missing.exists, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: enforce() → compileClaude → linter verification
// ---------------------------------------------------------------------------

describe("enforce() linter integration in compileClaude", () => {
  it("verifies eslint rules during compilation", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { errors, linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].exists, true);
    assert.equal(errors.filter((e) => e.type === "invalid-rule").length, 0);
  });

  it("errors on nonexistent linter rule during compilation", () => {
    const spec = claude({
      rules: {
        fake: enforce("eslint/completely-fake-xyz", "Doesn't exist."),
      },
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "invalid-rule"));
    assert.ok(errors.some((e) => e.message.includes("completely-fake-xyz")));
  });

  it("respects catalogOnly option", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
      catalogOnly: true,
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].exists, true);
  });
});

// ---------------------------------------------------------------------------
// Linter verification escape hatches
// ---------------------------------------------------------------------------

describe("linter verification disable options", () => {
  it("per-rule: verify: false skips linter check", () => {
    const spec = claude({
      rules: {
        "fake-rule": enforce("eslint/totally-fake-xyz", "Doesn't exist.", {
          verify: false,
        }),
      },
    });
    const { errors, linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Should NOT produce errors or linter results — verification skipped
    assert.equal(linterResults.length, 0);
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("per-rule: verify: true (default) checks linter", () => {
    const spec = claude({
      rules: {
        "fake-rule": enforce("eslint/totally-fake-xyz", "Doesn't exist."),
      },
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "invalid-rule"));
  });

  it("global: verifyLinters: false skips ALL linter checks", () => {
    const spec = claude({
      rules: {
        "fake-a": enforce("eslint/fake-a-xyz", "Nope."),
        "fake-b": enforce("ruff/FAKE999", "Nope."),
        "real-rule": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { errors, linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
      verifyLinters: false,
    });
    // No linter results at all — everything skipped
    assert.equal(linterResults.length, 0);
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("per-linter: false skips that linter only", () => {
    const spec = claude({
      rules: {
        "eslint-fake": enforce("eslint/fake-xyz", "Nope."),
        "ruff-fake": enforce("ruff/FAKE999", "Nope."),
      },
    });
    const { errors, linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
      linterModes: { eslint: false },
    });
    // eslint skipped, ruff still checked
    assert.ok(!linterResults.some((r) => r.linter === "eslint"));
    assert.ok(linterResults.some((r) => r.linter === "ruff"));
    // Only ruff error, not eslint
    assert.ok(errors.some((e) => e.message.includes("FAKE999")));
    assert.ok(!errors.some((e) => e.message.includes("fake-xyz")));
  });

  it("per-linter: catalog-only skips config check", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
      linterModes: { eslint: "catalog-only" },
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].exists, true);
    // In catalog-only mode, config-enabled check is skipped
  });

  it("per-rule verify: false takes priority over global verifyLinters: true", () => {
    const spec = claude({
      rules: {
        "skip-this": enforce("eslint/fake-xyz", "Skip.", { verify: false }),
        "check-this": enforce("eslint/no-console", "Check."),
      },
    });
    const { linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Only the verified rule produces a result
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].rule, "no-console");
  });

  it("global verifyLinters: false overrides per-linter modes", () => {
    const spec = claude({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
      verifyLinters: false,
      linterModes: { eslint: true },
    });
    // Global kill switch wins
    assert.equal(linterResults.length, 0);
  });
});

// ---------------------------------------------------------------------------
// adoptDiff() tests
// ---------------------------------------------------------------------------

describe("adoptDiff()", () => {
  it("detects unchanged compiled file", () => {
    const spec = claude({
      rules: { test: guidance("Hello.") },
    });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const { markdown } = compileClaude(spec, {
        basePath: tmpDir,
        specFile: "CLAUDE.md.spec.ts",
      });
      writeFileSync(join(tmpDir, "CLAUDE.md"), markdown);

      const result = adoptDiff("CLAUDE.md", spec, tmpDir);
      assert.equal(result.hasHash, true);
      assert.equal(result.valid, true);
      assert.equal(result.changed, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects manually edited file", () => {
    const spec = claude({
      rules: { test: guidance("Hello.") },
    });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-edit-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const { markdown } = compileClaude(spec, {
        basePath: tmpDir,
        specFile: "CLAUDE.md.spec.ts",
      });
      // Manually add a line
      const tampered =
        markdown + "\n### Hand-written rule\nSome extra content.\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), tampered);

      const result = adoptDiff("CLAUDE.md", spec, tmpDir);
      assert.equal(result.hasHash, true);
      assert.equal(result.valid, false);
      assert.equal(result.changed, true);
      assert.ok(result.addedLines.some((l) => l.includes("Hand-written rule")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles file without hash", () => {
    const spec = claude({ rules: {} });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-nohash-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Hand-written\n");
      const result = adoptDiff("CLAUDE.md", spec, tmpDir);
      assert.equal(result.hasHash, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty inputs, boundaries, special characters
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("compileClaude with empty spec produces valid markdown", () => {
    const spec = claude({ rules: {} });
    const { markdown, errors, tokens } = compileClaude(spec);
    assert.ok(markdown.includes("# CLAUDE.md"));
    assert.equal(errors.length, 0);
    assert.ok(tokens > 0);
  });

  it("compileClaude with only sections (no rules)", () => {
    const spec = claude({
      sections: { about: "This is a project." },
      rules: {},
    });
    const { markdown } = compileClaude(spec);
    assert.ok(markdown.includes("## About"));
    assert.ok(!markdown.includes("## Rules"));
  });

  it("maxRules at exact boundary passes", () => {
    const rules: Record<string, ReturnType<typeof guidance>> = {};
    for (let i = 0; i < 3; i++) {
      rules[`rule-${String(i)}`] = guidance("test");
    }
    const spec = claude({ rules });
    const { errors } = compileClaude(spec, { maxRules: 3 });
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("maxTokens at exact boundary passes", () => {
    const spec = claude({ rules: { a: guidance("x") } });
    const { tokens, errors } = compileClaude(spec, { maxTokens: 99999 });
    // Should pass — output is small
    assert.ok(!errors.some((e) => e.type === "budget-exceeded"));
    assert.ok(tokens > 0);
  });

  it("estimateTokens with empty string returns 0", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("computeHash with empty string is deterministic", () => {
    const a = computeHash("");
    const b = computeHash("");
    assert.equal(a, b);
    assert.ok(a.length > 0);
  });

  it("rule ID with underscores compiles to title case", () => {
    const spec = claude({
      rules: { no_console_log: guidance("Don't.") },
    });
    const { markdown } = compileClaude(spec);
    assert.ok(markdown.includes("### No Console Log"));
  });

  it("rule ID with hyphens compiles to title case", () => {
    const spec = claude({
      rules: { "barrel-imports-only": guidance("Use barrels.") },
    });
    const { markdown } = compileClaude(spec);
    assert.ok(markdown.includes("### Barrel Imports Only"));
  });

  it("compileSkill with empty body", () => {
    const spec = skill({
      name: "empty",
      description: "Nothing",
      body: "",
    });
    const { markdown } = compileSkill(spec);
    assert.ok(markdown.includes("name: empty"));
    assert.ok(markdown.includes("description: Nothing"));
  });

  it("executeAssertion with glob matching zero files", () => {
    const result = executeAssertion(
      "none",
      {
        _type: "file-pairing",
        glob: "nonexistent-dir-xyz/**/*.ts",
        pattern: "{name}.test.ts",
      },
      process.cwd(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.total, 0);
  });

  it("executeAssertion with {stem} placeholder on multi-dot files", () => {
    // src/spec.test.ts — {name} = "spec.test", {stem} = "spec"
    const result = executeAssertion(
      "test",
      {
        _type: "file-pairing",
        glob: "src/spec.test.ts",
        pattern: "{stem}.ts", // {stem} = "spec" → expects spec.ts
      },
      process.cwd(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.total, 1);
  });

  it("verifyHash with malformed hash line returns null", () => {
    const result = verifyHash("<!-- vigiles:sha256:tooshort -->\n# Content\n");
    // Hash must match the full regex pattern
    assert.equal(result, null);
  });

  it("multiple enforce rules all get linter-checked", () => {
    const spec = claude({
      rules: {
        "rule-a": enforce("eslint/no-console", "A"),
        "rule-b": enforce("eslint/no-debugger", "B"),
        "rule-c": guidance("Not checked."),
      },
    });
    const { linterResults } = compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Only enforce() rules produce linter results
    assert.equal(linterResults.length, 2);
    assert.ok(linterResults.every((r) => r.exists));
  });

  it("sections with file() ref to nonexistent file reports error", () => {
    const spec = claude({
      sections: {
        arch: instructions`See ${file("totally-fake-file-xyz.ts")}.`,
      },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "stale-file"));
  });

  it("cmd() validation catches missing npm scripts in commands", () => {
    const spec = claude({
      commands: {
        "npm run nonexistent-xyz": "Does not exist",
      },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "stale-command"));
  });

  it("cmd() validation passes for real npm scripts", () => {
    const spec = claude({
      commands: { "npm test": "Run tests", "npm run build": "Build" },
      rules: {},
    });
    const { errors } = compileClaude(spec, { basePath: process.cwd() });
    assert.ok(!errors.some((e) => e.type === "stale-command"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end roundtrip: compile → hash → verify → adopt
// ---------------------------------------------------------------------------

describe("compile → hash → verify → adopt roundtrip", () => {
  it("full lifecycle works end-to-end", () => {
    const spec = claude({
      commands: { "npm test": "Run tests" },
      keyFiles: { "src/spec.ts": "Spec system" },
      sections: { about: "A test project." },
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
        "test-files": check(
          every("src/spec.ts").has("{name}.test.ts"),
          "Every source needs tests.",
        ),
        "be-nice": guidance("Be nice to contributors."),
      },
    });

    const tmpDir = join(process.cwd(), ".vigiles-test-roundtrip-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      // Step 1: Compile
      const { markdown, errors, linterResults, tokens } = compileClaude(spec, {
        basePath: process.cwd(),
        specFile: "CLAUDE.md.spec.ts",
      });
      assert.equal(errors.length, 0);
      assert.ok(tokens > 0);
      assert.ok(linterResults.length > 0);

      // Step 2: Write compiled output
      const outPath = join(tmpDir, "CLAUDE.md");
      writeFileSync(outPath, markdown);

      // Step 3: Verify hash
      const hashResult = checkFileHash(outPath);
      assert.equal(hashResult.hasHash, true);
      assert.equal(hashResult.valid, true);
      assert.equal(hashResult.specFile, "CLAUDE.md.spec.ts");

      // Step 4: Adopt shows no changes
      const adoptResult = adoptDiff("CLAUDE.md", spec, tmpDir);
      assert.equal(adoptResult.valid, true);
      assert.equal(adoptResult.changed, false);

      // Step 5: Manually edit the file
      const tampered = markdown.replace(
        "Be nice to contributors.",
        "Be VERY nice to contributors.",
      );
      writeFileSync(outPath, tampered);

      // Step 6: Hash should now fail
      const hashResult2 = checkFileHash(outPath);
      assert.equal(hashResult2.valid, false);

      // Step 7: Adopt detects the change
      const adoptResult2 = adoptDiff("CLAUDE.md", spec, tmpDir);
      assert.equal(adoptResult2.valid, false);
      assert.equal(adoptResult2.changed, true);
      assert.ok(adoptResult2.addedLines.some((l) => l.includes("VERY nice")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
