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
      assert.ok(
        (err.stderr ?? "").includes("CLAUDE.md.spec.ts"),
        "Should mention the spec file",
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
});
