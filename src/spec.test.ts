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
} from "./compile.js";

import { generateTypes } from "./generate-types.js";

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
