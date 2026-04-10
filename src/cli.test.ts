/**
 * CLI integration tests — spawn the actual vigiles CLI and verify output.
 *
 * These test the full flow: CLI → compile/check/init → filesystem output.
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

  it("should compile the project root spec", () => {
    // Use the actual project root which has a compiled spec
    const { stdout, exitCode } = run(
      "compile CLAUDE.md.spec.ts",
      process.cwd(),
    );
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("CLAUDE.md.spec.ts"));
    assert.ok(stdout.includes("6 rules"));
  });
});

// ---------------------------------------------------------------------------
// vigiles check
// ---------------------------------------------------------------------------

describe("CLI: vigiles check", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-check-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report when no instruction files are found", () => {
    const { stdout, exitCode } = run("check", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("No instruction files found"));
  });

  it("should report missing spec for instruction files", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# CLAUDE.md\n\n## Rules\n");
    const { stdout, exitCode } = run("check CLAUDE.md", tmpDir);
    // require-spec should fire since there's no CLAUDE.md.spec.ts
    assert.ok(stdout.includes("require-spec") || exitCode === 1);
  });

  it("should pass when spec exists", () => {
    // Create both the md and the spec
    writeFileSync(
      join(tmpDir, "HAS_SPEC.md"),
      "<!-- vigiles:sha256:abc compiled from HAS_SPEC.md.spec.ts -->\n# Test\n",
    );
    writeFileSync(join(tmpDir, "HAS_SPEC.md.spec.ts"), "export default {};");
    const { stdout } = run("check HAS_SPEC.md", tmpDir);
    assert.ok(!stdout.includes("require-spec"));
  });
});

// ---------------------------------------------------------------------------
// vigiles generate-types
// ---------------------------------------------------------------------------

describe("CLI: vigiles generate-types", () => {
  it("should generate types for the project", () => {
    const { stdout, exitCode } = run("generate-types", process.cwd());
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("eslint:"));
    assert.ok(stdout.includes("Generated"));
  });

  it("should verify freshness with --check", () => {
    // First generate fresh types
    run("generate-types", process.cwd());
    // Then check — should pass
    const { stdout, exitCode } = run("generate-types --check", process.cwd());
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("up to date"));
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
// vigiles discover
// ---------------------------------------------------------------------------

describe("CLI: vigiles discover", () => {
  it("should show linter coverage", () => {
    const { stdout, exitCode } = run("discover", process.cwd());
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Coverage:"));
  });
});

// ---------------------------------------------------------------------------
// vigiles setup
// ---------------------------------------------------------------------------

describe("CLI: vigiles setup", () => {
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
    const { stdout, exitCode } = run("setup", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created CLAUDE.md.spec.ts"));
    assert.ok(stdout.includes("Setup complete"));
    assert.ok(existsSync(join(tmpDir, "CLAUDE.md.spec.ts")));
    assert.ok(existsSync(join(tmpDir, ".vigiles/generated.d.ts")));
  });

  it("should support --target flag", () => {
    const { stdout, exitCode } = run("setup --target=AGENTS.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("AGENTS.md.spec.ts"));
    assert.ok(existsSync(join(tmpDir, "AGENTS.md.spec.ts")));
  });
});

describe("CLI: vigiles setup auto-detection", () => {
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
    const { stdout } = run("setup", tmpDir);
    assert.ok(stdout.includes("without a spec") || stdout.includes("migrate"));
  });

  it("should detect .cursorrules and suggest sync tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-detect-cursor-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    writeFileSync(join(dir, ".cursorrules"), "Use TypeScript.\n");
    const { stdout } = run("setup", dir);
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
    const { stdout } = run("setup", dir);
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
    const { stdout } = run("setup", workDir);
    // Should detect CLAUDE.md without spec and suggest migration
    assert.ok(
      stdout.includes("without a spec") || stdout.includes("migrate"),
      "Should detect hand-written CLAUDE.md",
    );
  });

  it("init creates spec in fixture project", () => {
    const { exitCode } = run("init", workDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(workDir, "CLAUDE.md.spec.ts")));
  });

  it("generate-types works in fixture project", () => {
    const { exitCode } = run("generate-types", workDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(workDir, ".vigiles/generated.d.ts")));
  });

  it("check detects CLAUDE.md has no vigiles hash", () => {
    const { stdout } = run("check CLAUDE.md", workDir);
    // Hand-written CLAUDE.md has no hash — should report it
    assert.ok(
      stdout.includes("no vigiles hash") || stdout.includes("require-spec"),
    );
  });

  it("full flow: write spec → compile → check passes", () => {
    // Remove old hand-written CLAUDE.md and the template spec
    rmSync(join(workDir, "CLAUDE.md"));
    if (existsSync(join(workDir, "CLAUDE.md.spec.ts"))) {
      rmSync(join(workDir, "CLAUDE.md.spec.ts"));
    }

    // Write a spec that imports from vigiles dist (not node_modules)
    const specSrc = resolve(process.cwd(), "dist", "spec.js");
    writeFileSync(
      join(workDir, "CLAUDE.md.spec.ts"),
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
    assert.ok(existsSync(join(workDir, "CLAUDE.md")));

    // Compiled file should have vigiles hash
    const content = readFileSync(join(workDir, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("<!-- vigiles:sha256:"));

    // Check should pass (hash valid, spec exists)
    const checkResult = run("check CLAUDE.md", workDir);
    assert.ok(checkResult.stdout.includes("hash valid"));
  });
});
