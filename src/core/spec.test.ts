import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  enforce,
  guidance,
  file,
  cmd,
  ref,
  symbol,
  dir,
  glob,
  prose,
  experimental_effect,
  instructionFile,
  experimental_skill,
  experimental_agent,
} from "./spec.js";
const { result } = experimental_agent;
import type {
  SpecPath,
  OutputPath,
  StrictLinterRule,
  StrictFile,
  StrictCmd,
  RawSpec,
  RefsValidated,
  LintersVerified,
  ReadyToEmit,
  KnownLinterRules,
} from "./spec.js";

import {
  compileClaude,
  compileSkill,
  computeHash,
  addHash,
  verifyHash,
  checkFileHash,
  estimateTokens,
  adoptDiff,
} from "./compile.js";

import { generateTypes } from "./generate-types.js";
import { checkLinterRule } from "./linters.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { codexDialect } from "../adapters/codex/dialect.js";

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

describe("reference helpers", () => {
  it("file() creates a file ref", () => {
    const r = file("src/core/validate.ts");
    assert.equal(r._ref, "file");
    assert.equal(r.path, "src/core/validate.ts");
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

  it("dir() creates a dir ref", () => {
    const r = dir("src/core");
    assert.equal(r._ref, "dir");
    assert.equal(r.path, "src/core");
  });

  it("glob() creates a glob ref", () => {
    const r = glob("src/**/*.test.ts");
    assert.equal(r._ref, "glob");
    assert.equal(r.pattern, "src/**/*.test.ts");
  });
});

describe("instructions tagged template", () => {
  it("interleaves strings and refs", () => {
    const result = prose`Check ${file("foo.ts")} and run ${cmd("npm test")}.`;
    assert.equal(result.length, 5);
    assert.equal(typeof result[0], "string");
    assert.equal((result[1] as { _ref: string })._ref, "file");
    assert.equal(typeof result[2], "string");
    assert.equal((result[3] as { _ref: string })._ref, "cmd");
    assert.equal(typeof result[4], "string");
  });
});

describe("experimental_effect() tagged template", () => {
  it("produces an EffectRegion with correct _ref", () => {
    const region = experimental_effect`Side effects allowed here.`;
    assert.equal(region._ref, "effect");
    assert.equal(region.body.length, 1);
    assert.equal(typeof region.body[0], "string");
  });

  it("interleaves strings and InstructionFragment refs", () => {
    const region = experimental_effect`Write ${file("package.json")} and run ${cmd("npm publish")}.`;
    assert.equal(region._ref, "effect");
    assert.equal(region.body.length, 5);
    assert.equal(typeof region.body[0], "string");
    assert.equal((region.body[1] as { _ref: string })._ref, "file");
    assert.equal(typeof region.body[2], "string");
    assert.equal((region.body[3] as { _ref: string })._ref, "cmd");
    assert.equal(typeof region.body[4], "string");
  });

  it("can be nested inside instructions", () => {
    const frags = prose`Before. ${experimental_effect`Inside ${file("package.json")}.`} After.`;
    // [string, EffectRegion, string]
    assert.equal(frags.length, 3);
    const region = frags[1] as { _ref: string; body: unknown[] };
    assert.equal(region._ref, "effect");
    assert.ok(region.body.length > 0);
  });
});

describe("instructionFile()", () => {
  it("creates a claude spec with correct type tag", () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    assert.equal(spec._specType, "claude");
    assert.ok(spec.rules["no-console"]);
  });
});

describe("experimental_skill()", () => {
  it("creates a skill spec with correct type tag", () => {
    const spec = experimental_skill({
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
  it("compiles a minimal spec to markdown", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use structured logger."),
        "research-first": guidance("Google unfamiliar APIs first."),
      },
    });
    const { markdown, errors } = await compileClaude(spec);
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

  it("includes commands section", async () => {
    const spec = instructionFile({
      commands: { "npm test": "Run tests" },
      rules: {},
    });
    const { markdown } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("## Commands"));
    assert.ok(markdown.includes("`npm test` — Run tests"));
  });

  it("includes key files section", async () => {
    const spec = instructionFile({
      keyFiles: { "src/core/spec.ts": "Spec system" },
      rules: {},
    });
    const { markdown } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("## Key Files"));
    assert.ok(markdown.includes("`src/core/spec.ts` — Spec system"));
  });

  it("reports errors for missing key files", async () => {
    const spec = instructionFile({
      keyFiles: { "src/nonexistent-file-xyz.ts": "Does not exist" },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });

  it("reports errors for missing npm scripts", async () => {
    const spec = instructionFile({
      commands: { "npm run nonexistent-script-xyz": "Does not exist" },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-command");
  });

  it("symbol() renders `file#symbol` and verifies the named file defines it", async () => {
    const ok = instructionFile({
      sections: {
        u: prose`Use ${symbol("src/core/symbols.ts", "definedSymbols")}.`,
      },
      rules: {},
    });
    const okRes = await compileClaude(ok, { basePath: process.cwd() });
    assert.equal(okRes.errors.length, 0);
    assert.match(
      okRes.markdown,
      /`vigiles:symbol src\/core\/symbols\.ts#definedSymbols`/,
    );

    const bad = instructionFile({
      sections: {
        u: prose`Use ${symbol("src/core/symbols.ts", "noSuchSymbol")}.`,
      },
      rules: {},
    });
    const badRes = await compileClaude(bad, { basePath: process.cwd() });
    assert.ok(badRes.errors.some((e) => e.type === "stale-ref"));
  });

  it("includes sections in output", async () => {
    const spec = instructionFile({
      sections: {
        architecture: "TypeScript strict-mode codebase.",
      },
      rules: {},
    });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("## Architecture"));
    assert.ok(markdown.includes("TypeScript strict-mode codebase."));
  });

  it("enforces maxRules limit", async () => {
    const rules: Record<string, ReturnType<typeof guidance>> = {};
    for (let i = 0; i < 5; i++) {
      rules[`rule-${String(i)}`] = guidance("test");
    }
    const spec = instructionFile({ rules });
    const { errors } = await compileClaude(spec, { maxRules: 3 });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("exceeds maxRules"));
  });

  it("returns linterResults for enforce rules", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    // eslint is installed in this project, so this should work
    const { linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].linter, "eslint");
    assert.equal(linterResults[0].rule, "no-console");
    assert.equal(linterResults[0].exists, true);
  });
});

describe("compileSkill()", () => {
  it("compiles a skill with string body", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: "Do the thing.\n\n## Step 1\nDo step 1.",
    });
    const { markdown, errors } = await compileSkill(spec);
    assert.ok(markdown.includes("<!-- vigiles:sha256:"));
    assert.ok(markdown.includes("name: test-skill\n"));
    assert.ok(markdown.includes("description: A test skill"));
    assert.ok(markdown.includes("Do the thing."));
    assert.equal(errors.length, 0);
  });

  it("an over-long inline code block is a WARNING, not a blocking error", async () => {
    // A >20-line inline code block is an authoring smell worth surfacing, but it
    // never breaks the harness — so it's a non-blocking warning, and a faithful
    // adoption of a code-heavy skill still compiles (errors stay empty).
    const bigBlock = "```ts\n" + "const x = 1;\n".repeat(25) + "```";
    const spec = experimental_skill({
      name: "code-heavy",
      description: "A skill with a big code example",
      body: `Do the thing.\n\n${bigBlock}\n`,
    });
    const { errors, warnings } = await compileSkill(spec);
    assert.equal(errors.length, 0); // does NOT block compilation
    assert.ok(
      warnings.some((w) => w.type === "inline-code-too-long"),
      "the long code block is surfaced as a warning",
    );
  });

  it("renders context: fork and a forked skill's typed output contract", async () => {
    const spec = experimental_skill({
      name: "review",
      description: "Review a file.",
      context: "fork", // runs as a subagent → has a return boundary
      output: result({ defects: "string[]" }, { reason: "string" }),
      body: "Review the file.",
    });
    const { markdown, errors } = await compileSkill(spec);
    assert.equal(errors.length, 0);
    assert.ok(markdown.includes("context: fork"));
    assert.ok(markdown.includes("## Output contract"));
    assert.ok(markdown.includes("```vigiles:ok"));
    assert.ok(markdown.includes('"defects": string[]'));
  });

  it("errors when output is set WITHOUT context: fork (inline = no return)", async () => {
    const spec = experimental_skill({
      name: "review",
      description: "Review a file.",
      output: result({ ok: "boolean" }, { reason: "string" }),
      body: "Review the file.",
    });
    const { errors } = await compileSkill(spec);
    assert.ok(errors.some((e) => e.type === "output-without-fork"));
  });

  it("compiles a skill with tagged template body", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`Check ${file("package.json")} and run ${cmd("npm test")}.`,
    });
    const { markdown } = await compileSkill(spec, { basePath: process.cwd() });
    assert.ok(markdown.includes("`package.json`"));
    assert.ok(markdown.includes("`npm test`"));
  });

  it("reports errors for missing file refs in body", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`Check ${file("nonexistent-xyz.ts")}.`,
    });
    const { errors } = await compileSkill(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });

  it("verifies a dir() ref against a real directory", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`The engine lives in ${dir("src/core")}.`,
    });
    const { markdown, errors } = await compileSkill(spec, {
      basePath: process.cwd(),
    });
    assert.equal(errors.length, 0);
    assert.ok(markdown.includes("`src/core`"));
  });

  it("flags a dir() ref to a missing directory", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`See ${dir("src/nonexistent-dir-xyz")}.`,
    });
    const { errors } = await compileSkill(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-file");
  });

  it("flags a dir() ref that points at a FILE, not a directory", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`See ${dir("package.json")}.`,
    });
    const { errors } = await compileSkill(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-ref");
    assert.match(errors[0].message, /Not a directory/);
  });

  it("verifies a glob() ref that matches at least one file", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`Specs: ${glob("src/core/*.test.ts")}.`,
    });
    const { markdown, errors } = await compileSkill(spec, {
      basePath: process.cwd(),
    });
    assert.equal(errors.length, 0);
    assert.ok(markdown.includes("`src/core/*.test.ts`"));
  });

  it("flags a glob() ref that matches nothing", async () => {
    const spec = experimental_skill({
      name: "test-skill",
      description: "A test skill",
      body: prose`Specs: ${glob("src/**/*.nonexistent-ext")}.`,
    });
    const { errors } = await compileSkill(spec, { basePath: process.cwd() });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, "stale-ref");
    assert.match(errors[0].message, /matched no files/);
  });

  it("includes frontmatter fields", async () => {
    const spec = experimental_skill({
      name: "my-skill",
      description: "My skill desc",
      disableModelInvocation: true,
      argumentHint: "<some arg>",
      body: "Instructions here.",
    });
    const { markdown } = await compileSkill(spec);
    assert.ok(markdown.includes("disable-model-invocation: true"));
    assert.ok(markdown.includes("argument-hint: <some arg>"));
  });

  it("claude-code dialect frontmatter is unchanged (default == claudeCodeDialect)", async () => {
    const spec = experimental_skill({
      name: "my-skill",
      description: "My skill desc",
      disableModelInvocation: true,
      argumentHint: "<some arg>",
      body: "Instructions here.",
    });
    // No dialect (default) and the explicit CC dialect must be byte-identical —
    // the full CC frontmatter set, exactly as before.
    const def = (await compileSkill(spec)).markdown;
    const cc = (await compileSkill(spec, { dialect: claudeCodeDialect }))
      .markdown;
    assert.equal(def, cc);
    assert.ok(cc.includes("disable-model-invocation: true"));
    assert.ok(cc.includes("argument-hint: <some arg>"));
  });

  it("codex (minimal) dialect emits ONLY name + description frontmatter", async () => {
    const spec = experimental_skill({
      name: "my-skill",
      description: "My skill desc",
      disableModelInvocation: true,
      argumentHint: "<some arg>",
      body: "Instructions here.",
    });
    const { markdown } = await compileSkill(spec, { dialect: codexDialect });
    assert.ok(markdown.includes("name: my-skill"));
    assert.ok(markdown.includes("description: My skill desc"));
    // The CC-only keys must be ABSENT under the minimal profile.
    assert.ok(!markdown.includes("disable-model-invocation"));
    assert.ok(!markdown.includes("argument-hint"));
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
  it("errors when compiled output exceeds maxTokens", async () => {
    const spec = instructionFile({
      sections: { prose: "x".repeat(1000) },
      rules: {},
    });
    const { errors, tokens } = await compileClaude(spec, { maxTokens: 100 });
    assert.ok(tokens > 100);
    assert.ok(errors.some((e) => e.type === "budget-exceeded"));
  });

  it("passes when under budget", async () => {
    const spec = instructionFile({
      rules: { test: guidance("Short.") },
    });
    const { errors } = await compileClaude(spec, { maxTokens: 10000 });
    assert.ok(!errors.some((e) => e.type === "budget-exceeded"));
  });
});

// ---------------------------------------------------------------------------
// Section guardrails (headers + length)
// ---------------------------------------------------------------------------

describe("section guardrails", () => {
  it("errors when section contains a top-level header", async () => {
    const spec = instructionFile({
      sections: { about: "Some intro\n# Overview\nMore text" },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "section-has-header"));
  });

  it("errors when section contains a second-level header", async () => {
    const spec = instructionFile({
      sections: { about: "Some intro\n## Subsection\nMore text" },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "section-has-header"));
  });

  it("allows ### and deeper headers in sections", async () => {
    const spec = instructionFile({
      sections: { about: "Some intro\n### Detail\nMore text" },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(!errors.some((e) => e.type === "section-has-header"));
  });

  it("does not flag # inside code fences", async () => {
    const spec = instructionFile({
      sections: { about: "Example:\n```\n# this is a comment\n```" },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(!errors.some((e) => e.type === "section-has-header"));
  });

  it("does not flag # inside tilde code fences", async () => {
    const spec = instructionFile({
      sections: { about: "Example:\n~~~\n## heading in fence\n~~~" },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(!errors.some((e) => e.type === "section-has-header"));
  });

  it("flags # after code fence closes", async () => {
    const spec = instructionFile({
      sections: {
        about: "Example:\n```\n# safe\n```\n# not safe",
      },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "section-has-header"));
  });

  it("errors when section exceeds maxSectionLines", async () => {
    const longContent = Array.from(
      { length: 50 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({
      sections: { wall: longContent },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { maxSectionLines: 20 });
    assert.ok(errors.some((e) => e.type === "section-too-long"));
    assert.ok(errors[0].message.includes("50 lines"));
    assert.ok(errors[0].message.includes("max 20"));
  });

  it("passes when section is at exact maxSectionLines boundary", async () => {
    const content = Array.from(
      { length: 20 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({
      sections: { ok: content },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { maxSectionLines: 20 });
    assert.ok(!errors.some((e) => e.type === "section-too-long"));
  });

  it("allows a normal section under the generous default (no maxSectionLines)", async () => {
    // 100 lines is well under the 200-line default — real prose sections are short.
    const content = Array.from(
      { length: 100 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({ sections: { ok: content }, rules: {} });
    const { errors } = await compileClaude(spec);
    assert.ok(!errors.some((e) => e.type === "section-too-long"));
  });

  it("applies a generous DEFAULT cap (200 lines) with no maxSectionLines set", async () => {
    // An egregious dump trips the default guard even when the author set no cap —
    // TS types can't bound string length, so this is the compile-time backstop.
    const dump = Array.from(
      { length: 250 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({ sections: { wall: dump }, rules: {} });
    const { errors } = await compileClaude(spec);
    const tooLong = errors.find((e) => e.type === "section-too-long");
    assert.ok(tooLong, "the default cap should fire on a 250-line section");
    assert.ok(tooLong.message.includes("max 200"));
    assert.ok(tooLong.message.includes("maxSectionLines")); // points at the override
  });
});

// ---------------------------------------------------------------------------
// Reserved section keys (#4)
// ---------------------------------------------------------------------------

describe("reserved section keys", () => {
  it("errors when section key is 'commands'", async () => {
    const spec = instructionFile({
      sections: { commands: "Should use the commands field instead." },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "reserved-section-key"));
  });

  it("errors when section key is 'rules'", async () => {
    const spec = instructionFile({
      sections: { rules: "Should use the rules field instead." },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "reserved-section-key"));
  });

  it("errors when section key is 'keyFiles'", async () => {
    const spec = instructionFile({
      sections: { keyFiles: "Should use the keyFiles field instead." },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "reserved-section-key"));
  });

  it("allows non-reserved section keys", async () => {
    const spec = instructionFile({
      sections: { architecture: "This is fine." },
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(!errors.some((e) => e.type === "reserved-section-key"));
  });
});

// ---------------------------------------------------------------------------
// Per-spec maxSectionLines (#5)
// ---------------------------------------------------------------------------

describe("per-spec maxSectionLines", () => {
  it("uses spec.maxSectionLines when set", async () => {
    const longContent = Array.from(
      { length: 30 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({
      sections: { wall: longContent },
      maxSectionLines: 20,
      rules: {},
    });
    const { errors } = await compileClaude(spec);
    assert.ok(errors.some((e) => e.type === "section-too-long"));
  });

  it("compile option overrides spec maxSectionLines", async () => {
    const longContent = Array.from(
      { length: 30 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({
      sections: { wall: longContent },
      maxSectionLines: 50, // spec says 50, which would pass
      rules: {},
    });
    // But compile option says 20, which is stricter
    // Actually spec takes precedence — let's verify:
    const { errors } = await compileClaude(spec, { maxSectionLines: 10 });
    // spec.maxSectionLines (50) takes precedence over options (10)
    assert.ok(!errors.some((e) => e.type === "section-too-long"));
  });

  it("falls back to compile option when spec has no maxSectionLines", async () => {
    const longContent = Array.from(
      { length: 30 },
      (_, i) => `Line ${String(i + 1)}`,
    ).join("\n");
    const spec = instructionFile({
      sections: { wall: longContent },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { maxSectionLines: 20 });
    assert.ok(errors.some((e) => e.type === "section-too-long"));
  });
});

// ---------------------------------------------------------------------------
// Sections with file() refs
// ---------------------------------------------------------------------------

describe("sections with refs", () => {
  it("compiles sections with file() refs and validates them", async () => {
    const spec = instructionFile({
      sections: {
        architecture: prose`Core engine in ${file("src/core/spec.ts")}.`,
      },
      rules: {},
    });
    const { markdown, errors } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    assert.ok(markdown.includes("`src/core/spec.ts`"));
    assert.equal(errors.length, 0);
  });

  it("reports stale file refs in sections", async () => {
    const spec = instructionFile({
      sections: {
        architecture: prose`See ${file("src/nonexistent-xyz.ts")}.`,
      },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
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
    assert.ok(result.files.includes("src/core/spec.ts"));
    assert.ok(result.files.includes("src/core/compile.ts"));
  });

  it("generates valid .d.ts content", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(result.dts.includes('declare module "vigiles/generated"'));
    assert.ok(result.dts.includes("export type EslintRule"));
    assert.ok(result.dts.includes("export type NpmScript"));
    assert.ok(result.dts.includes("export type ProjectFile"));
  });

  it("generates vigiles/spec augmentation for KnownLinterRules", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(
      result.dts.includes('declare module "vigiles/spec"'),
      "Should augment vigiles/spec",
    );
    assert.ok(
      result.dts.includes("interface KnownLinterRules"),
      "Should populate KnownLinterRules",
    );
    assert.ok(
      result.dts.includes('"eslint"'),
      "Should include eslint key in KnownLinterRules",
    );
  });

  it("generates KnownProjectFiles augmentation", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(
      result.dts.includes("interface KnownProjectFiles"),
      "Should populate KnownProjectFiles",
    );
  });

  it("generates KnownNpmScripts augmentation", () => {
    const result = generateTypes({ basePath: process.cwd() });
    assert.ok(
      result.dts.includes("interface KnownNpmScripts"),
      "Should populate KnownNpmScripts",
    );
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
  it("verifies eslint rules during compilation", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { errors, linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].exists, true);
    assert.equal(errors.filter((e) => e.type === "invalid-rule").length, 0);
  });

  it("errors on nonexistent linter rule during compilation", async () => {
    const spec = instructionFile({
      rules: {
        fake: enforce("eslint/completely-fake-xyz", "Doesn't exist."),
      },
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "invalid-rule"));
    assert.ok(errors.some((e) => e.message.includes("completely-fake-xyz")));
  });

  it("respects catalogOnly option", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = await compileClaude(spec, {
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
  it("per-rule: verify: false skips linter check", async () => {
    const spec = instructionFile({
      rules: {
        "fake-rule": enforce("eslint/totally-fake-xyz", "Doesn't exist.", {
          verify: false,
        }),
      },
    });
    const { errors, linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Should NOT produce errors or linter results — verification skipped
    assert.equal(linterResults.length, 0);
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("per-rule: verify: true (default) checks linter", async () => {
    const spec = instructionFile({
      rules: {
        "fake-rule": enforce("eslint/totally-fake-xyz", "Doesn't exist."),
      },
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "invalid-rule"));
  });

  it("global: verifyLinters: false skips ALL linter checks", async () => {
    const spec = instructionFile({
      rules: {
        "fake-a": enforce("eslint/fake-a-xyz", "Nope."),
        "fake-b": enforce("ruff/FAKE999", "Nope."),
        "real-rule": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { errors, linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
      verifyLinters: false,
    });
    // No linter results at all — everything skipped
    assert.equal(linterResults.length, 0);
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("per-linter: false skips that linter only", async () => {
    const spec = instructionFile({
      rules: {
        "eslint-fake": enforce("eslint/fake-xyz", "Nope."),
        "ruff-fake": enforce("ruff/FAKE999", "Nope."),
      },
    });
    const { errors, linterResults } = await compileClaude(spec, {
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

  it("per-linter: catalog-only skips config check", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
      linterModes: { eslint: "catalog-only" },
    });
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].exists, true);
    // In catalog-only mode, config-enabled check is skipped
  });

  it("per-rule verify: false takes priority over global verifyLinters: true", async () => {
    const spec = instructionFile({
      rules: {
        "skip-this": enforce("eslint/fake-xyz", "Skip.", { verify: false }),
        "check-this": enforce("eslint/no-console", "Check."),
      },
    });
    const { linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Only the verified rule produces a result
    assert.equal(linterResults.length, 1);
    assert.equal(linterResults[0].rule, "no-console");
  });

  it("global verifyLinters: false overrides per-linter modes", async () => {
    const spec = instructionFile({
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
      },
    });
    const { linterResults } = await compileClaude(spec, {
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
  it("detects unchanged compiled file", async () => {
    const spec = instructionFile({
      rules: { test: guidance("Hello.") },
    });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const { markdown } = await compileClaude(spec, {
        basePath: tmpDir,
        specFile: "CLAUDE.md.spec.ts",
      });
      writeFileSync(join(tmpDir, "CLAUDE.md"), markdown);

      const result = await adoptDiff(
        "CLAUDE.md",
        spec,
        tmpDir,
        claudeCodeDialect,
      );
      assert.equal(result.hasHash, true);
      assert.equal(result.valid, true);
      assert.equal(result.changed, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects manually edited file", async () => {
    const spec = instructionFile({
      rules: { test: guidance("Hello.") },
    });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-edit-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const { markdown } = await compileClaude(spec, {
        basePath: tmpDir,
        specFile: "CLAUDE.md.spec.ts",
      });
      // Manually add a line
      const tampered =
        markdown + "\n### Hand-written rule\nSome extra content.\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), tampered);

      const result = await adoptDiff(
        "CLAUDE.md",
        spec,
        tmpDir,
        claudeCodeDialect,
      );
      assert.equal(result.hasHash, true);
      assert.equal(result.valid, false);
      assert.equal(result.changed, true);
      assert.ok(result.addedLines.some((l) => l.includes("Hand-written rule")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles file without hash", async () => {
    const spec = instructionFile({ rules: {} });
    const tmpDir = join(process.cwd(), ".vigiles-test-adopt-nohash-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Hand-written\n");
      const result = await adoptDiff(
        "CLAUDE.md",
        spec,
        tmpDir,
        claudeCodeDialect,
      );
      assert.equal(result.hasHash, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Type system features (#1, #5, #6, #7)
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("exports strict type aliases", () => {
    // Verify the types exist and are usable at runtime (type-only check
    // happens at tsc time, but we can verify the imports resolve).
    void ("eslint/no-console" as StrictLinterRule);
    void ("src/core/spec.ts" as StrictFile);
    void ("npm run build" as StrictCmd);
    assert.ok(true, "strict types are importable");
  });

  it("exports augmentation interfaces (empty by default)", () => {
    // Without generated types, the interfaces have no keys.
    // This test just verifies they're importable.
    type HasNoKeys = [keyof KnownLinterRules] extends [never] ? true : false;
    const result: HasNoKeys = true;
    assert.equal(result, true);
  });

  it("exports phantom type brands", () => {
    // Verify pipeline stage types are importable
    void (null as unknown as RawSpec);
    void (null as unknown as RefsValidated);
    void (null as unknown as LintersVerified);
    void (null as unknown as ReadyToEmit);
    assert.ok(true, "phantom types are importable");
  });

  it("instructionFile() stores maxSectionLines on the spec", () => {
    const spec = instructionFile({
      sections: { about: "Hello" },
      maxSectionLines: 25,
      rules: {},
    });
    assert.equal(spec.maxSectionLines, 25);
  });

  it("instructionFile() without sections has no maxSectionLines", () => {
    const spec = instructionFile({ rules: {} });
    assert.equal(spec.maxSectionLines, undefined);
  });

  it("SpecPath and OutputPath are inverse type-level operations", () => {
    // SpecPath<"CLAUDE.md"> = "CLAUDE.md.spec.ts"
    void ("CLAUDE.md.spec.ts" as SpecPath<"CLAUDE.md">);
    // OutputPath<"CLAUDE.md.spec.ts"> = "CLAUDE.md"
    void ("CLAUDE.md" as OutputPath<"CLAUDE.md.spec.ts">);
    assert.ok(true, "spec path types are importable and correct");
  });
});

// ---------------------------------------------------------------------------
// Spec file naming convention (#11)
// ---------------------------------------------------------------------------

describe("spec file naming convention", () => {
  it("accepts valid CLAUDE.md.spec.ts name", async () => {
    const spec = instructionFile({ rules: {} });
    const { errors } = await compileClaude(spec, {
      specFile: "CLAUDE.md.spec.ts",
    });
    assert.ok(!errors.some((e) => e.type === "spec-name-mismatch"));
  });

  it("accepts valid nested path spec name", async () => {
    const spec = instructionFile({ rules: {} });
    const { errors } = await compileClaude(spec, {
      specFile: "src/CLAUDE.md.spec.ts",
    });
    assert.ok(!errors.some((e) => e.type === "spec-name-mismatch"));
  });

  it("errors when spec file does not end with .spec.ts", async () => {
    const spec = instructionFile({ rules: {} });
    const { errors } = await compileClaude(spec, {
      specFile: "CLAUDE.md.ts",
    });
    assert.ok(errors.some((e) => e.type === "spec-name-mismatch"));
  });

  it("errors when spec file does not match target", async () => {
    const spec = instructionFile({ rules: {} });
    const { errors } = await compileClaude(spec, {
      specFile: "AGENTS.md.spec.ts",
    });
    // Default target is CLAUDE.md, but spec says AGENTS.md
    assert.ok(errors.some((e) => e.type === "spec-name-mismatch"));
    assert.ok(errors[0].message.includes("doesn't match"));
  });

  it("accepts SKILL.md.spec.ts for skills", async () => {
    const spec = experimental_skill({
      name: "test",
      description: "Test skill",
      body: "Do the thing.",
    });
    const { errors } = await compileSkill(spec, {
      specFile: "skills/test/SKILL.md.spec.ts",
    });
    assert.ok(!errors.some((e) => e.type === "spec-name-mismatch"));
  });

  it("errors for skills with wrong spec name", async () => {
    const spec = experimental_skill({
      name: "test",
      description: "Test skill",
      body: "Do the thing.",
    });
    const { errors } = await compileSkill(spec, {
      specFile: "skills/test/skill.spec.ts",
    });
    assert.ok(errors.some((e) => e.type === "spec-name-mismatch"));
  });
});

// ---------------------------------------------------------------------------
// Output target
// ---------------------------------------------------------------------------

describe("output target", () => {
  it("defaults to CLAUDE.md heading", async () => {
    const spec = instructionFile({ rules: {} });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("# CLAUDE.md"));
  });

  it("uses custom target for heading", async () => {
    const spec = instructionFile({ target: "AGENTS.md", rules: {} });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("# AGENTS.md"));
    assert.ok(!markdown.includes("# CLAUDE.md"));
  });

  it("defaults specFile based on target", async () => {
    const spec = instructionFile({ target: "AGENTS.md", rules: {} });
    // Without explicit specFile, it should derive from target
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("compiled from AGENTS.md.spec.ts"));
  });

  it("accepts AGENTS.md.spec.ts naming for AGENTS.md target", async () => {
    const spec = instructionFile({ target: "AGENTS.md", rules: {} });
    const { errors } = await compileClaude(spec, {
      specFile: "AGENTS.md.spec.ts",
    });
    assert.ok(!errors.some((e) => e.type === "spec-name-mismatch"));
  });

  it("accepts custom target name", async () => {
    const spec = instructionFile({ target: "CODEX.md", rules: {} });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("# CODEX.md"));
  });

  it("returns all targets from array", async () => {
    const spec = instructionFile({
      target: ["CLAUDE.md", "AGENTS.md"],
      rules: {},
    });
    const { targets, markdown } = await compileClaude(spec);
    assert.deepEqual(targets, ["CLAUDE.md", "AGENTS.md"]);
    // Primary target is first in array
    assert.ok(markdown.includes("# CLAUDE.md"));
  });

  it("returns single target in targets array", async () => {
    const spec = instructionFile({ target: "AGENTS.md", rules: {} });
    const { targets } = await compileClaude(spec);
    assert.deepEqual(targets, ["AGENTS.md"]);
  });

  it("defaults targets to CLAUDE.md", async () => {
    const spec = instructionFile({ rules: {} });
    const { targets } = await compileClaude(spec);
    assert.deepEqual(targets, ["CLAUDE.md"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty inputs, boundaries, special characters
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("compileClaude with empty spec produces valid markdown", async () => {
    const spec = instructionFile({ rules: {} });
    const { markdown, errors, tokens } = await compileClaude(spec);
    assert.ok(markdown.includes("# CLAUDE.md"));
    assert.equal(errors.length, 0);
    assert.ok(tokens > 0);
  });

  it("compileClaude with only sections (no rules)", async () => {
    const spec = instructionFile({
      sections: { about: "This is a project." },
      rules: {},
    });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("## About"));
    assert.ok(!markdown.includes("## Rules"));
  });

  it("maxRules at exact boundary passes", async () => {
    const rules: Record<string, ReturnType<typeof guidance>> = {};
    for (let i = 0; i < 3; i++) {
      rules[`rule-${String(i)}`] = guidance("test");
    }
    const spec = instructionFile({ rules });
    const { errors } = await compileClaude(spec, { maxRules: 3 });
    assert.ok(!errors.some((e) => e.type === "invalid-rule"));
  });

  it("maxTokens at exact boundary passes", async () => {
    const spec = instructionFile({ rules: { a: guidance("x") } });
    const { tokens, errors } = await compileClaude(spec, { maxTokens: 99999 });
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

  it("rule ID with underscores compiles to title case", async () => {
    const spec = instructionFile({
      rules: { no_console_log: guidance("Don't.") },
    });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("### No Console Log"));
  });

  it("rule ID with hyphens compiles to title case", async () => {
    const spec = instructionFile({
      rules: { "barrel-imports-only": guidance("Use barrels.") },
    });
    const { markdown } = await compileClaude(spec);
    assert.ok(markdown.includes("### Barrel Imports Only"));
  });

  it("compileSkill with empty body", async () => {
    const spec = experimental_skill({
      name: "empty",
      description: "Nothing",
      body: "",
    });
    const { markdown } = await compileSkill(spec);
    assert.ok(markdown.includes("name: empty"));
    assert.ok(markdown.includes("description: Nothing"));
  });

  it("verifyHash with malformed hash line returns null", () => {
    const result = verifyHash("<!-- vigiles:sha256:tooshort -->\n# Content\n");
    // Hash must match the full regex pattern
    assert.equal(result, null);
  });

  it("multiple enforce rules all get linter-checked", async () => {
    const spec = instructionFile({
      rules: {
        "rule-a": enforce("eslint/no-console", "A"),
        "rule-b": enforce("eslint/no-debugger", "B"),
        "rule-c": guidance("Not checked."),
      },
    });
    const { linterResults } = await compileClaude(spec, {
      basePath: process.cwd(),
    });
    // Only enforce() rules produce linter results
    assert.equal(linterResults.length, 2);
    assert.ok(linterResults.every((r) => r.exists));
  });

  it("sections with file() ref to nonexistent file reports error", async () => {
    const spec = instructionFile({
      sections: {
        arch: prose`See ${file("totally-fake-file-xyz.ts")}.`,
      },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "stale-file"));
  });

  it("cmd() validation catches missing npm scripts in commands", async () => {
    const spec = instructionFile({
      commands: {
        "npm run nonexistent-xyz": "Does not exist",
      },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(errors.some((e) => e.type === "stale-command"));
  });

  it("cmd() validation passes for real npm scripts", async () => {
    const spec = instructionFile({
      commands: { "npm test": "Run tests", "npm run build": "Build" },
      rules: {},
    });
    const { errors } = await compileClaude(spec, { basePath: process.cwd() });
    assert.ok(!errors.some((e) => e.type === "stale-command"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end roundtrip: compile → hash → verify → adopt
// ---------------------------------------------------------------------------

describe("compile → hash → verify → adopt roundtrip", () => {
  it("full lifecycle works end-to-end", async () => {
    const spec = instructionFile({
      commands: { "npm test": "Run tests" },
      keyFiles: { "src/core/spec.ts": "Spec system" },
      sections: { about: "A test project." },
      rules: {
        "no-console": enforce("eslint/no-console", "Use logger."),
        "no-unused": enforce("eslint/no-unused-vars", "Keep code clean."),
        "be-nice": guidance("Be nice to contributors."),
      },
    });

    const tmpDir = join(process.cwd(), ".vigiles-test-roundtrip-tmp");
    mkdirSync(tmpDir, { recursive: true });
    try {
      // Step 1: Compile
      const { markdown, errors, linterResults, tokens } = await compileClaude(
        spec,
        {
          basePath: process.cwd(),
          specFile: "CLAUDE.md.spec.ts",
        },
      );
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
      const adoptResult = await adoptDiff(
        "CLAUDE.md",
        spec,
        tmpDir,
        claudeCodeDialect,
      );
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
      const adoptResult2 = await adoptDiff(
        "CLAUDE.md",
        spec,
        tmpDir,
        claudeCodeDialect,
      );
      assert.equal(adoptResult2.valid, false);
      assert.equal(adoptResult2.changed, true);
      assert.ok(adoptResult2.addedLines.some((l) => l.includes("VERY nice")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
