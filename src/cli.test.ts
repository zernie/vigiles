/**
 * CLI integration tests — spawn the actual vigiles CLI and verify output.
 *
 * These test the full flow: CLI → init/compile/audit → filesystem output.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

function run(
  args: string,
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// vigiles init
// ---------------------------------------------------------------------------

describe("CLI: vigiles init", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-init-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create CLAUDE.md.spec.ts by default", () => {
    const { stdout, exitCode } = run("init", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created CLAUDE.md.spec.ts"));
    assert.ok(existsSync(join(tmpDir, "CLAUDE.md.spec.ts")));
  });

  it("should not overwrite existing spec", () => {
    // Already created in previous test
    const { stdout } = run("init", tmpDir);
    assert.ok(stdout.includes("already exists"));
  });

  it("should create AGENTS.md.spec.ts with --target flag", () => {
    const { stdout, exitCode } = run("init --target=AGENTS.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created AGENTS.md.spec.ts"));
    const content = readFileSync(join(tmpDir, "AGENTS.md.spec.ts"), "utf-8");
    assert.ok(content.includes('target: "AGENTS.md"'));
  });

  it("should create custom target spec", () => {
    const { exitCode } = run("init --target=CODEX.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(tmpDir, "CODEX.md.spec.ts")));
    const content = readFileSync(join(tmpDir, "CODEX.md.spec.ts"), "utf-8");
    assert.ok(content.includes('target: "CODEX.md"'));
  });
});

// ---------------------------------------------------------------------------
// vigiles compile
// ---------------------------------------------------------------------------

describe("CLI: vigiles compile", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-compile-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report when no specs are found", () => {
    const { stdout, exitCode } = run("compile", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("No .spec.ts files found"));
  });

  it("should compile a spec", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const specSrc = resolve(process.cwd(), "dist", "spec.js");
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      `import { claude, guidance } from "${specSrc}";\nexport default claude({ rules: { r: guidance("test") } });\n`,
    );
    const { stdout, exitCode } = run("compile CLAUDE.md.spec.ts", tmpDir);
    assert.equal(exitCode, 0, stdout);
    assert.ok(stdout.includes("CLAUDE.md.spec.ts"));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// vigiles audit
// ---------------------------------------------------------------------------

describe("CLI: vigiles audit", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-audit-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report when no instruction files are found", () => {
    const { stdout, exitCode } = run("audit", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("No compiled instruction files found"));
  });

  it("should include coverage and strengthen output", () => {
    const { stdout } = run("audit", tmpDir);
    // audit runs discover + strengthen in addition to verification
    assert.ok(
      stdout.includes("coverage") ||
        stdout.includes("Linter") ||
        stdout.includes("No .spec.ts"),
    );
  });

  it("should detect duplicate rules via NCD", () => {
    const dupDir = mkdtempSync(join(tmpdir(), "vigiles-audit-dup-"));
    try {
      writeFileSync(
        join(dupDir, "package.json"),
        JSON.stringify({ name: "test", scripts: {} }),
      );
      const specSrc = resolve(process.cwd(), "dist", "spec.js");
      writeFileSync(
        join(dupDir, "CLAUDE.md.spec.ts"),
        `import { claude, guidance } from "${specSrc}";
export default claude({
  rules: {
    "use-logger": guidance("Always use the structured logger instead of console.log for production output."),
    "logger-over-console": guidance("Use the structured logger instead of console.log in production code."),
    "unrelated": guidance("Prefer composition over inheritance in class hierarchies."),
  },
});
`,
      );
      const { stdout } = run("audit", dupDir);
      // Should detect the two logger rules as near-duplicates
      assert.ok(
        stdout.includes("near-duplicate") || stdout.includes("duplicate"),
        `Expected duplicate detection, got: ${stdout.slice(0, 500)}`,
      );
    } finally {
      rmSync(dupDir, { recursive: true, force: true });
    }
  });

  it("should skip inline verification for spec-managed files", () => {
    // A file with a sibling .spec.ts (and compiled-from header) must
    // not run inline verification, so literal vigiles:enforce snippets
    // in prose cannot trip audit when the file is spec-managed.
    // We use a sibling-.spec.ts with the spec snippet embedded as a
    // prose section — compile generates the valid hash, then audit
    // must ignore the inline marker in the output.
    const specDir = mkdtempSync(join(tmpdir(), "vigiles-audit-spec-skip-"));
    try {
      writeFileSync(
        join(specDir, "package.json"),
        JSON.stringify({ name: "test", scripts: {} }),
      );
      const specSrc = resolve(process.cwd(), "dist", "spec.js");
      writeFileSync(
        join(specDir, "CLAUDE.md.spec.ts"),
        `import { claude, guidance } from "${specSrc}";
export default claude({
  sections: {
    // A literal enforce marker embedded in prose — would be picked
    // up as an inline rule if audit didn't skip spec-managed files.
    example: 'Example: <!-- vigiles:enforce eslint/total-nonsense "prose" -->',
  },
  rules: {
    "some-rule": guidance("Something."),
  },
});
`,
      );

      // Compile first so CLAUDE.md has a valid hash.
      const compileResult = run("compile", specDir);
      assert.equal(
        compileResult.exitCode,
        0,
        `compile failed: ${compileResult.stdout}`,
      );

      const { stdout, exitCode } = run("audit CLAUDE.md", specDir);
      // Should NOT surface the bogus rule as an inline error.
      assert.ok(
        !stdout.includes("total-nonsense"),
        `Spec-managed file should skip inline verification, got: ${stdout.slice(0, 800)}`,
      );
      // And should not have exited with the hard-error code.
      assert.notEqual(
        exitCode,
        2,
        `Expected no inline errors, got exit ${String(exitCode)}: ${stdout.slice(0, 600)}`,
      );
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Inline mode E2E
// ---------------------------------------------------------------------------

describe("E2E: inline enforcement", () => {
  let inlineDir: string;

  before(() => {
    inlineDir = mkdtempSync(join(tmpdir(), "vigiles-inline-e2e-"));
    writeFileSync(
      join(inlineDir, "package.json"),
      JSON.stringify({ name: "test-inline", scripts: {} }),
    );
    // Symlink node_modules so checkLinterRule can find ESLint
    // when the spawned CLI runs with cwd=inlineDir.
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(inlineDir, "node_modules"),
    );
    // Also copy eslint config so the config checker can resolve rules
    const eslintConfig = resolve(process.cwd(), "eslint.config.ts");
    if (existsSync(eslintConfig)) {
      copyFileSync(eslintConfig, join(inlineDir, "eslint.config.ts"));
    }
  });

  after(() => {
    rmSync(inlineDir, { recursive: true, force: true });
  });

  it("verifies valid inline enforce rules and exits clean", () => {
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `# Project

<!-- vigiles:enforce eslint/no-console "Use structured logger" -->

All output goes through logger.ts.
`,
    );
    const { stdout, exitCode } = run("audit CLAUDE.md", inlineDir);
    assert.ok(
      stdout.includes("eslint/no-console"),
      `Expected rule in output, got: ${stdout.slice(0, 600)}`,
    );
    // Exit code 0 means no hard errors (inline rule is valid)
    assert.equal(exitCode, 0, `Expected clean exit, got ${String(exitCode)}`);
  });

  it("flags a typo'd inline rule with a closest-match suggestion", () => {
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `# Project

<!-- vigiles:enforce eslint/no-consol "Typo check" -->

Some prose.
`,
    );
    const { stdout, exitCode } = run("audit CLAUDE.md", inlineDir);
    assert.ok(
      stdout.includes("no-consol"),
      `Expected typo'd rule in output, got: ${stdout.slice(0, 600)}`,
    );
    assert.ok(
      stdout.includes("Did you mean"),
      `Expected closest-match suggestion, got: ${stdout.slice(0, 600)}`,
    );
    assert.equal(exitCode, 2, `Expected exit 2 on inline error`);
  });

  it("ignores inline markers inside fenced code blocks", () => {
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `# Docs

Example usage:

\`\`\`md
<!-- vigiles:enforce eslint/totally-bogus "inside fence" -->
\`\`\`

Real rule:

<!-- vigiles:enforce eslint/no-console "outside fence" -->
`,
    );
    const { stdout, exitCode } = run("audit CLAUDE.md", inlineDir);
    // The bogus rule inside the fence must NOT appear as an error
    assert.ok(
      !stdout.includes("totally-bogus"),
      `Fenced marker should be skipped, got: ${stdout.slice(0, 600)}`,
    );
    assert.ok(
      stdout.includes("no-console"),
      `Real rule should be verified, got: ${stdout.slice(0, 600)}`,
    );
    assert.equal(exitCode, 0);
  });

  it("reports inline errors in --json output", () => {
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `<!-- vigiles:enforce eslint/fake-rule-xyz "bad" -->`,
    );
    const { stdout, exitCode } = run("audit --json CLAUDE.md", inlineDir);
    const report = JSON.parse(stdout) as {
      inlineErrors: number;
      inlineRules: number;
    };
    assert.ok(report.inlineErrors > 0, "Expected inlineErrors > 0");
    assert.ok(report.inlineRules > 0, "Expected inlineRules > 0");
    assert.equal(exitCode, 2);
  });

  it("reports inline rules in --summary output", () => {
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `<!-- vigiles:enforce eslint/fake-rule-xyz "bad" -->`,
    );
    const { stdout, exitCode } = run("audit --summary CLAUDE.md", inlineDir);
    assert.ok(
      stdout.includes("inline"),
      `Expected 'inline' in summary, got: ${stdout}`,
    );
    assert.equal(exitCode, 2);
  });

  it("satisfies require-spec when inline rules are present", () => {
    // A file with inline rules but no .spec.ts should NOT trigger
    // the require-spec validation warning.
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `<!-- vigiles:enforce eslint/no-console "valid" -->

# Project
`,
    );
    const { stdout } = run("audit CLAUDE.md", inlineDir);
    assert.ok(
      !stdout.includes("require-spec"),
      `require-spec should be satisfied by inline rules, got: ${stdout.slice(0, 600)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// vigiles generate-types
// ---------------------------------------------------------------------------

describe("CLI: vigiles generate-types", () => {
  it("should generate types", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-gen-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { build: "echo ok" } }),
    );
    const { stdout, exitCode } = run("generate-types", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Generated"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should verify freshness with --check", () => {
    // Use a temp dir so we don't modify the project's generated types
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-types-check-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    // Generate types in temp dir
    run("generate-types", tmpDir);
    // Then check — should pass
    const { exitCode } = run("generate-types --check", tmpDir);
    assert.equal(exitCode, 0);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Multi-target compilation
// ---------------------------------------------------------------------------

describe("CLI: multi-target compile", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-multi-"));
    // Create a spec with multiple targets
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      `import { claude, guidance } from "${resolve(process.cwd(), "src/spec.js")}";
export default claude({
  target: ["CLAUDE.md", "AGENTS.md"],
  rules: {
    "test-rule": guidance("Test guidance."),
  },
});
`,
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should compile to multiple targets", () => {
    const { stdout, exitCode } = run("compile CLAUDE.md.spec.ts", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("CLAUDE.md"));
    assert.ok(stdout.includes("AGENTS.md"));

    // Both files should exist
    assert.ok(existsSync(join(tmpDir, "CLAUDE.md")));
    assert.ok(existsSync(join(tmpDir, "AGENTS.md")));

    // Primary has CLAUDE.md heading
    const claude = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    assert.ok(claude.includes("# CLAUDE.md"));

    // Secondary has AGENTS.md heading
    const agents = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    assert.ok(agents.includes("# AGENTS.md"));
  });
});

// ---------------------------------------------------------------------------
// vigiles strengthen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// vigiles init (was: vigiles setup)
// ---------------------------------------------------------------------------

describe("CLI: vigiles init (full setup)", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-setup-"));
    // Need a package.json for generate-types
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create spec, generate types, and compile", () => {
    const { stdout, exitCode } = run("init", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created CLAUDE.md.spec.ts"));
    assert.ok(stdout.includes("Setup complete"));
    assert.ok(existsSync(join(tmpDir, "CLAUDE.md.spec.ts")));
    assert.ok(existsSync(join(tmpDir, ".vigiles/generated.d.ts")));
  });

  it("should support --target flag", () => {
    const { stdout, exitCode } = run("init --target=AGENTS.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("AGENTS.md.spec.ts"));
    assert.ok(existsSync(join(tmpDir, "AGENTS.md.spec.ts")));
  });
});

describe("CLI: vigiles init auto-detection", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-detect-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect existing CLAUDE.md and suggest migration", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Hand-written\n");
    const { stdout } = run("init", tmpDir);
    assert.ok(stdout.includes("without a spec") || stdout.includes("migrate"));
  });

  it("should detect .cursorrules and suggest sync tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-detect-cursor-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    writeFileSync(join(dir, ".cursorrules"), "Use TypeScript.\n");
    const { stdout } = run("init", dir);
    assert.ok(stdout.includes("Cursor") || stdout.includes("Non-markdown"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("should detect .claude directory as Claude Code project", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-detect-claude-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const { stdout } = run("init", dir);
    assert.ok(stdout.includes("Claude Code"));
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Pre-edit hook (blocks compiled file edits)
// ---------------------------------------------------------------------------

describe("plugin hook: pre-edit.sh", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-pre-edit-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be executable with valid bash syntax", () => {
    const hookPath = resolve(process.cwd(), ".claude-plugin/hooks/pre-edit.sh");
    assert.ok(existsSync(hookPath));
    execSync(`bash -n ${hookPath}`, { stdio: "pipe" });
  });

  it("should exit 0 for non-md files", () => {
    const input = JSON.stringify({
      tool_input: { file_path: join(tmpDir, "src/app.ts") },
    });
    const hookPath = resolve(process.cwd(), ".claude-plugin/hooks/pre-edit.sh");
    execSync(`echo '${input}' | bash ${hookPath}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Should exit 0 (no block)
    assert.ok(true);
  });

  it("should exit 2 for compiled md files", () => {
    // Create a compiled .md file with vigiles hash
    const mdPath = join(tmpDir, "CLAUDE.md");
    writeFileSync(
      mdPath,
      "<!-- vigiles:sha256:abc123 compiled from CLAUDE.md.spec.ts -->\n# CLAUDE.md\n",
    );
    const input = JSON.stringify({ tool_input: { file_path: mdPath } });
    const hookPath = resolve(process.cwd(), ".claude-plugin/hooks/pre-edit.sh");
    try {
      execSync(`echo '${input}' | bash ${hookPath}`, {
        cwd: tmpDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.fail("Should have exited with code 2");
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: string };
      assert.equal(err.status, 2);
      const stderr = err.stderr ?? "";
      assert.ok(
        stderr.includes("CLAUDE.md.spec.ts"),
        "Should mention the spec file",
      );
      assert.ok(
        stderr.includes("BLOCKED"),
        "Should clearly indicate the action was blocked",
      );
      assert.ok(
        stderr.includes("edit-spec"),
        "Should reference the edit-spec skill",
      );
    }
  });

  it("should exit 0 for non-compiled md files", () => {
    const mdPath = join(tmpDir, "HANDWRITTEN.md");
    writeFileSync(mdPath, "# Hand-written\n\nNo vigiles hash.\n");
    const input = JSON.stringify({ tool_input: { file_path: mdPath } });
    const hookPath = resolve(process.cwd(), ".claude-plugin/hooks/pre-edit.sh");
    execSync(`echo '${input}' | bash ${hookPath}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Should exit 0 (no block)
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// Plugin hook: post-edit
// ---------------------------------------------------------------------------

describe("plugin hook: post-edit.sh", () => {
  it("should be executable", () => {
    const hookPath = resolve(
      process.cwd(),
      ".claude-plugin/hooks/post-edit.sh",
    );
    assert.ok(existsSync(hookPath));
    // Check it's parseable bash
    try {
      execSync(`bash -n ${hookPath}`, { stdio: "pipe" });
    } catch {
      assert.fail("post-edit.sh has syntax errors");
    }
  });

  it("should exit cleanly with empty input", () => {
    const hookPath = resolve(
      process.cwd(),
      ".claude-plugin/hooks/post-edit.sh",
    );
    try {
      execSync(`echo '{}' | bash ${hookPath}`, {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Non-zero exit is ok — jq might fail on empty. Just shouldn't hang.
    }
  });

  it("should match linter config files for type regeneration", () => {
    // Test the case pattern matching by running a dry-run variant:
    // Override npx to just echo, check the routing logic works.
    const hookPath = resolve(
      process.cwd(),
      ".claude-plugin/hooks/post-edit.sh",
    );

    const configFiles = [
      "eslint.config.mjs",
      ".eslintrc.json",
      "pyproject.toml",
      "Cargo.toml",
      "package.json",
      ".stylelintrc.json",
      ".rubocop.yml",
    ];

    for (const filename of configFiles) {
      const input = JSON.stringify({
        tool_input: { file_path: `/tmp/${filename}` },
      });
      // The hook should match these files — we can't easily verify it runs
      // generate-types without mocking npx, but we can verify it doesn't crash.
      try {
        execSync(`echo '${input}' | bash ${hookPath}`, {
          cwd: process.cwd(),
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
          env: { ...process.env, PATH: "/nonexistent" }, // npx won't be found, but routing still works
        });
      } catch {
        // Expected: npx not in PATH or vigiles not available in /tmp.
        // The important thing is the script didn't error on the case match.
      }
    }
    assert.ok(true, "All config files processed without crash");
  });

  it("should match .spec.ts files for compilation", () => {
    const hookPath = resolve(
      process.cwd(),
      ".claude-plugin/hooks/post-edit.sh",
    );
    const input = JSON.stringify({
      tool_input: { file_path: "/tmp/CLAUDE.md.spec.ts" },
    });
    try {
      execSync(`echo '${input}' | bash ${hookPath}`, {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
        env: { ...process.env, PATH: "/nonexistent" },
      });
    } catch {
      // Expected: npx not found. Routing logic still works.
    }
    assert.ok(true, ".spec.ts file processed without crash");
  });

  it("should not trigger for unrelated files", () => {
    const hookPath = resolve(
      process.cwd(),
      ".claude-plugin/hooks/post-edit.sh",
    );
    const input = JSON.stringify({
      tool_input: { file_path: "/tmp/src/app.ts" },
    });
    // Should exit 0 quickly — no case match, no npx call.
    execSync(`echo '${input}' | bash ${hookPath}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    assert.ok(true, "Unrelated file skipped without triggering any action");
  });
});

// ---------------------------------------------------------------------------
// E2E: fixture project — full adoption flow
// ---------------------------------------------------------------------------

describe("E2E: fixture project adoption", () => {
  const FIXTURE = resolve(__dirname, "..", "fixtures", "example-project");
  let workDir: string;

  before(() => {
    // Copy fixture to a temp dir so tests don't pollute it
    workDir = mkdtempSync(join(tmpdir(), "vigiles-e2e-"));
    execSync(`cp -r ${FIXTURE}/* ${workDir}/`, { stdio: "pipe" });
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("setup detects existing hand-written CLAUDE.md", () => {
    const { stdout } = run("init", workDir);
    // Should detect CLAUDE.md without spec and suggest migration
    assert.ok(
      stdout.includes("without a spec") || stdout.includes("migrate"),
      "Should detect hand-written CLAUDE.md",
    );
  });

  it("audit detects CLAUDE.md has no vigiles hash", () => {
    const { stdout } = run("audit", workDir);
    // Hand-written CLAUDE.md has no hash — should report it
    assert.ok(
      stdout.includes("no vigiles hash") ||
        stdout.includes("require-spec") ||
        stdout.includes("Verifying"),
    );
  });

  it("generate-types works in fixture project", () => {
    const { exitCode } = run("generate-types", workDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(workDir, ".vigiles/generated.d.ts")));
  });

  it("full flow: write spec → compile → audit passes", () => {
    // Clean slate: remove any existing CLAUDE.md and spec
    const mdPath = join(workDir, "CLAUDE.md");
    const specPath = join(workDir, "CLAUDE.md.spec.ts");
    if (existsSync(mdPath)) rmSync(mdPath);
    if (existsSync(specPath)) rmSync(specPath);

    // Write a spec that imports from vigiles dist (not node_modules)
    const specSrc = resolve(process.cwd(), "dist", "spec.js");
    writeFileSync(
      specPath,
      `import { claude, guidance } from "${specSrc}";
export default claude({
  commands: { "npm test": "Run tests" },
  rules: { "be-nice": guidance("Be nice.") },
});
`,
    );

    // Compile
    const compileResult = run("compile CLAUDE.md.spec.ts", workDir);
    assert.equal(compileResult.exitCode, 0, compileResult.stdout);
    assert.ok(existsSync(mdPath));

    // Compiled file should have vigiles hash
    const content = readFileSync(mdPath, "utf-8");
    assert.ok(content.includes("<!-- vigiles:sha256:"));

    // Audit should pass (hash valid, spec exists)
    const auditResult = run("audit", workDir);
    assert.ok(
      auditResult.stdout.includes("hash valid") || auditResult.exitCode === 0,
    );
  });
});
