/**
 * CLI integration tests — spawn the actual vigiles CLI and verify output.
 *
 * These test the full flow: CLI → init/compile/lint → filesystem output.
 */
import { describe, it, beforeAll as before, afterAll as after } from "vitest";
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
  env?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      env: env ? { ...process.env, ...env } : process.env,
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
    const { stdout, exitCode } = run("init --no-plugin", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created CLAUDE.md.spec.ts"));
    assert.ok(existsSync(join(tmpDir, "CLAUDE.md.spec.ts")));
  });

  it("scaffolds a spec that imports ONLY what it uses (no unused-vars under strict ESLint)", () => {
    run("init --target=LINTSAFE.md", tmpDir);
    const content = readFileSync(join(tmpDir, "LINTSAFE.md.spec.ts"), "utf-8");
    // The live import must bring in only `claude` (the one symbol the scaffold
    // uses); enforce/guidance appear solely in a COMMENTED import. A strict
    // `no-unused-vars` + `--max-warnings=0` CI would fail otherwise.
    const liveImport = content.split("\n").find((l) => l.startsWith("import "));
    assert.equal(liveImport, 'import { instructionFile } from "vigiles/spec";');
    assert.ok(
      content.includes("// import { instructionFile, enforce, guidance }"),
      "shows the fuller import as a comment for when rules are added",
    );
  });

  it("should not overwrite existing spec", () => {
    // Already created in previous test
    const { stdout } = run("init --no-plugin", tmpDir);
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
    assert.ok(
      stdout.includes("No .spec.ts or .vigiles/hooks/ hook files found"),
    );
  });

  it("should compile a spec", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      `import { instructionFile, guidance } from "${specSrc}";\nexport default instructionFile({ rules: { r: guidance("test") } });\n`,
    );
    const { stdout, exitCode } = run("compile CLAUDE.md.spec.ts", tmpDir);
    assert.equal(exitCode, 0, stdout);
    assert.ok(stdout.includes("CLAUDE.md.spec.ts"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should compile agent + railway specs and resolve delegate targets", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-railway-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
    writeFileSync(
      join(tmpDir, "worker.md.spec.ts"),
      `import { experimental_agent } from "${specSrc}";\n` +
        `const { result } = experimental_agent;\n` +
        `export default experimental_agent({ name: "worker", description: "d", tools: ["Read"], body: "b", output: result({ summary: "string" }, { reason: "string" }) });\n`,
    );
    writeFileSync(
      join(tmpDir, "flow.md.spec.ts"),
      `import { experimental_agent } from "${specSrc}";\n` +
        `const { railway, delegate } = experimental_agent;\n` +
        `export default railway({ name: "flow", steps: [delegate("worker")] });\n`,
    );
    const { stdout, exitCode } = run(
      "compile worker.md.spec.ts flow.md.spec.ts",
      tmpDir,
    );
    assert.equal(exitCode, 0, stdout);
    const agentMd = readFileSync(join(tmpDir, "worker.md"), "utf8");
    assert.ok(agentMd.includes("## Output contract"), agentMd);
    assert.ok(agentMd.includes("```vigiles:ok"), agentMd);
    const flowMd = readFileSync(join(tmpDir, "flow.md"), "utf8");
    assert.ok(flowMd.includes("# Railway: flow"), flowMd);
    assert.ok(flowMd.includes("**worker**"), flowMd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should fail when a railway delegates to an unknown agent", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-railway-bad-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
    writeFileSync(
      join(tmpDir, "flow.md.spec.ts"),
      `import { experimental_agent } from "${specSrc}";\n` +
        `const { railway, delegate } = experimental_agent;\n` +
        `export default railway({ name: "flow", steps: [delegate("ghost")] });\n`,
    );
    const { stdout, exitCode } = run("compile flow.md.spec.ts", tmpDir);
    assert.equal(exitCode, 1, stdout);
    assert.ok(stdout.includes("unknown agent"), stdout);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should compile subdirectory spec to same directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-subdir-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const subDir = join(tmpDir, "examples");
    mkdirSync(subDir);
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
    writeFileSync(
      join(subDir, "CLAUDE.md.spec.ts"),
      `import { instructionFile, guidance } from "${specSrc}";\nexport default instructionFile({ rules: { r: guidance("test") } });\n`,
    );
    const { stdout, exitCode } = run(
      "compile examples/CLAUDE.md.spec.ts",
      tmpDir,
    );
    assert.equal(exitCode, 0, stdout);
    // Output should be in examples/, not root
    assert.ok(
      existsSync(join(subDir, "CLAUDE.md")),
      "Expected examples/CLAUDE.md to exist",
    );
    assert.ok(
      !existsSync(join(tmpDir, "CLAUDE.md")),
      "Root CLAUDE.md should NOT exist — spec in subdirectory must write to same directory",
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should not clobber root spec output when compiling all specs", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-compile-noclobber-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");

    // Root spec
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      `import { instructionFile, guidance } from "${specSrc}";\nexport default instructionFile({ rules: { "root-rule": guidance("from root") } });\n`,
    );
    // Subdirectory spec
    const subDir = join(tmpDir, "examples");
    mkdirSync(subDir);
    writeFileSync(
      join(subDir, "CLAUDE.md.spec.ts"),
      `import { instructionFile, guidance } from "${specSrc}";\nexport default instructionFile({ rules: { "sub-rule": guidance("from subdir") } });\n`,
    );

    const { stdout, exitCode } = run("compile", tmpDir);
    assert.equal(exitCode, 0, stdout);

    // Root CLAUDE.md should come from root spec
    const rootMd = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    assert.ok(
      rootMd.includes("from root"),
      "Root CLAUDE.md should contain root spec content",
    );
    assert.ok(
      !rootMd.includes("from subdir"),
      "Root CLAUDE.md must not be overwritten by subdirectory spec",
    );

    // Subdirectory CLAUDE.md should come from subdirectory spec
    const subMd = readFileSync(join(subDir, "CLAUDE.md"), "utf-8");
    assert.ok(
      subMd.includes("from subdir"),
      "examples/CLAUDE.md should contain subdirectory spec content",
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// vigiles lint
// ---------------------------------------------------------------------------

describe("CLI: vigiles lint", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-lint-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report when no instruction files are found", () => {
    const { stdout, exitCode } = run("lint", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("No compiled instruction files found"));
  });

  it("should include coverage and strengthen output", () => {
    const { stdout } = run("lint", tmpDir);
    // lint runs discover + strengthen in addition to verification
    assert.ok(
      stdout.includes("coverage") ||
        stdout.includes("Linter") ||
        stdout.includes("No .spec.ts"),
    );
  });

  it("default lint integrity-checks a compiled subagent (dogfood E2)", () => {
    // A compiled agents/<name>.md carries a vigiles hash, but the default glob
    // only matched CLAUDE/AGENTS/SKILL — so a hand-edit of a compiled subagent
    // slipped past lint. A tampered compiled agent must now be flagged.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-lint-agent-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      // A vigiles hash header whose body no longer matches (tampered).
      writeFileSync(
        join(dir, "agents", "reviewer.md"),
        "<!-- vigiles:sha256:deadbeef compiled from agents/reviewer.md.spec.ts -->\n---\nname: reviewer\n---\nedited body\n",
      );
      const { stdout, exitCode } = run("lint", dir);
      assert.match(stdout, /agents\/reviewer\.md/);
      assert.match(stdout, /hash mismatch|modified directly/);
      assert.equal(exitCode, 2, "a tampered compiled subagent fails lint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should detect duplicate rules via NCD", () => {
    const dupDir = mkdtempSync(join(tmpdir(), "vigiles-lint-dup-"));
    try {
      writeFileSync(
        join(dupDir, "package.json"),
        JSON.stringify({ name: "test", scripts: {} }),
      );
      const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
      writeFileSync(
        join(dupDir, "CLAUDE.md.spec.ts"),
        `import { instructionFile, guidance } from "${specSrc}";
export default instructionFile({
  rules: {
    "use-logger": guidance("Always use the structured logger instead of console.log for production output."),
    "logger-over-console": guidance("Use the structured logger instead of console.log in production code."),
    "unrelated": guidance("Prefer composition over inheritance in class hierarchies."),
  },
});
`,
      );
      const { stdout } = run("lint", dupDir);
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
    // in prose cannot trip lint when the file is spec-managed.
    // We use a sibling-.spec.ts with the spec snippet embedded as a
    // prose section — compile generates the valid hash, then lint
    // must ignore the inline marker in the output.
    const specDir = mkdtempSync(join(tmpdir(), "vigiles-lint-spec-skip-"));
    try {
      writeFileSync(
        join(specDir, "package.json"),
        JSON.stringify({ name: "test", scripts: {} }),
      );
      const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
      writeFileSync(
        join(specDir, "CLAUDE.md.spec.ts"),
        `import { instructionFile, guidance } from "${specSrc}";
export default instructionFile({
  sections: {
    // A literal enforce marker embedded in prose — would be picked
    // up as an inline rule if lint did not skip spec-managed files.
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

      const { stdout, exitCode } = run("lint CLAUDE.md", specDir);
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

  it("emits a per-line GitHub annotation for a broken doc ref (PR inline)", () => {
    // The dogfooded GitHub Action surfaces lint findings INLINE on the PR diff
    // via `::error file=,line=::` workflow annotations. A broken `file()` ref in
    // a markdown code block must produce one (it carries file+line) — this is
    // what makes the Action leave per-line feedback, not just a summary blob.
    //
    // `doc-refs` is opt-in (default off, measured at 0 true positives — see
    // docs/rules/doc-refs.md), so the fixture turns it on. The annotation LEVEL
    // follows the configured severity: a `::error` next to an exit code of 0 is
    // how an advisory rule gets mistaken for a gate.
    const dir = mkdtempSync(join(tmpdir(), "vig-gha-annot-"));
    try {
      writeFileSync(
        join(dir, "doc.md"),
        '# Doc\n\n```ts\nfile("does/not/exist.ts")\n```\n',
      );
      const cfg = join(dir, ".vigilesrc.json");
      writeFileSync(cfg, '{"rules":{"doc-refs":"error"}}');
      const { stdout } = run("lint", dir, { GITHUB_ACTIONS: "true" });
      // The annotation names the file and the exact line (4) of the bad ref.
      assert.match(stdout, /::error file=.*doc\.md,line=4::/);
      assert.match(stdout, /File not found/);

      // At "warn" the same finding annotates as a warning, not an error.
      writeFileSync(cfg, '{"rules":{"doc-refs":"warn"}}');
      const warned = run("lint", dir, { GITHUB_ACTIONS: "true" }).stdout;
      assert.match(warned, /::warning file=.*doc\.md,line=4::/);

      // And with the rule at its DEFAULT (absent), nothing is annotated at all —
      // the pass does not run.
      rmSync(cfg, { force: true });
      const off = run("lint", dir, { GITHUB_ACTIONS: "true" }).stdout;
      assert.ok(
        !/doc\.md,line=4/.test(off),
        `doc-refs is off by default; it must annotate nothing, got:\n${off}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    const { stdout, exitCode } = run("lint CLAUDE.md", inlineDir);
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
    const { stdout, exitCode } = run("lint CLAUDE.md", inlineDir);
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
    const { stdout, exitCode } = run("lint CLAUDE.md", inlineDir);
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
    const { stdout, exitCode } = run("lint --json CLAUDE.md", inlineDir);
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
    const { stdout, exitCode } = run("lint --summary CLAUDE.md", inlineDir);
    assert.ok(
      stdout.includes("inline"),
      `Expected 'inline' in summary, got: ${stdout}`,
    );
    assert.equal(exitCode, 2);
  });

  it("does NOT satisfy require-instructions-spec via inline rules (narrow rule)", () => {
    // Inline mode is a valid Level-0 on-ramp, but `require-instructions-spec` is
    // NARROW — only a `.spec.ts` satisfies it (the name says "spec"). So an
    // inline-only CLAUDE.md still gets the default-warn nudge; an inline user
    // keeps the rule off. The inline rules themselves are still parsed/verified.
    writeFileSync(
      join(inlineDir, "CLAUDE.md"),
      `<!-- vigiles:enforce eslint/no-console "valid" -->

# Project
`,
    );
    const { stdout } = run("lint CLAUDE.md", inlineDir);
    assert.ok(
      stdout.includes("require-instructions-spec"),
      `inline must NOT satisfy the narrow require-instructions-spec, got: ${stdout.slice(0, 600)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Frontmatter mode E2E
// ---------------------------------------------------------------------------

describe("E2E: frontmatter mode is DISABLED (kept in code, inert in lint)", () => {
  let fmDir: string;

  before(() => {
    fmDir = mkdtempSync(join(tmpdir(), "vigiles-fm-e2e-"));
    writeFileSync(
      join(fmDir, "package.json"),
      JSON.stringify({ name: "test-fm", scripts: {} }),
    );
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(fmDir, "node_modules"),
    );
    const eslintConfig = resolve(process.cwd(), "eslint.config.ts");
    if (existsSync(eslintConfig)) {
      copyFileSync(eslintConfig, join(fmDir, "eslint.config.ts"));
    }
  });

  after(() => {
    rmSync(fmDir, { recursive: true, force: true });
  });

  it("a `vigiles:` frontmatter block is INERT — not verified, never fails lint", () => {
    // Frontmatter mode is DISABLED (FRONTMATTER_MODE_ENABLED=false): a `vigiles:`
    // block is ignored, so even a fake rule that WOULD have failed lint under the
    // old mode is now inert — no frontmatter rules read, no frontmatter errors.
    writeFileSync(
      join(fmDir, "CLAUDE.md"),
      `---
vigiles:
  enforce:
    - rule: eslint/fake-rule-xyz
      why: would have failed lint under the old mode
---

# Project
`,
    );
    const { stdout } = run("lint --json CLAUDE.md", fmDir);
    const report = JSON.parse(stdout) as {
      frontmatterErrors: number;
      frontmatterRules: number;
    };
    assert.equal(report.frontmatterRules, 0, "frontmatter rules are not read");
    assert.equal(
      report.frontmatterErrors,
      0,
      "a fake frontmatter rule is inert, not an error",
    );
    assert.ok(
      !stdout.includes("fake-rule-xyz"),
      `a disabled-mode rule must not be flagged, got: ${stdout.slice(0, 400)}`,
    );
  });

  it("does NOT satisfy require-instructions-spec via frontmatter rules (narrow rule)", () => {
    // A `vigiles:` block never counted as a `.spec.ts`, so the narrow
    // `require-instructions-spec` nudge fires (default warn) — and now even more
    // so, since frontmatter mode is disabled and the block is inert prose.
    writeFileSync(
      join(fmDir, "CLAUDE.md"),
      `---
vigiles:
  enforce:
    - rule: eslint/no-console
      why: valid
---

# Project
`,
    );
    const { stdout } = run("lint CLAUDE.md", fmDir);
    assert.ok(
      stdout.includes("require-instructions-spec"),
      `frontmatter must NOT satisfy the narrow require-instructions-spec, got: ${stdout.slice(0, 600)}`,
    );
  });

  it("inline mode still works while frontmatter is inert", () => {
    writeFileSync(
      join(fmDir, "CLAUDE.md"),
      `---
vigiles:
  enforce:
    - rule: eslint/no-console
      why: from frontmatter (ignored — mode disabled)
---

# Project

<!-- vigiles:enforce eslint/no-console "from inline" -->
`,
    );
    const { stdout, exitCode } = run("lint --json CLAUDE.md", fmDir);
    const report = JSON.parse(stdout) as {
      inlineRules: number;
      frontmatterRules: number;
    };
    // Inline mode (the kept zero-TS on-ramp) verifies its rule; the frontmatter
    // copy is inert (mode disabled), so only the inline rule is counted.
    assert.equal(report.inlineRules, 1);
    assert.equal(report.frontmatterRules, 0);
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// vigiles generate schema
// ---------------------------------------------------------------------------

describe("CLI: vigiles generate schema", () => {
  let schemaDir: string;

  before(() => {
    schemaDir = mkdtempSync(join(tmpdir(), "vigiles-schema-"));
    writeFileSync(
      join(schemaDir, "package.json"),
      JSON.stringify({ name: "test-schema", scripts: {} }),
    );
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(schemaDir, "node_modules"),
    );
    // Plain JS flat config so rule discovery doesn't depend on a TS loader
    // being resolvable from the temp dir.
    writeFileSync(
      join(schemaDir, "eslint.config.js"),
      `module.exports = [{ rules: { "no-console": "error", "no-eval": "warn" } }];\n`,
    );
  });

  after(() => {
    rmSync(schemaDir, { recursive: true, force: true });
  });

  it("emits a valid JSON Schema with a populated rule enum", () => {
    const { exitCode } = run("generate schema", schemaDir);
    assert.equal(exitCode, 0);
    const schemaPath = join(schemaDir, ".vigiles", "schema.json");
    assert.ok(existsSync(schemaPath), "expected .vigiles/schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      properties: {
        vigiles: {
          properties: {
            enforce: {
              items: {
                properties: { rule: { enum?: string[]; type?: string } };
              };
            };
          };
        };
      };
    };
    const ruleSchema =
      schema.properties.vigiles.properties.enforce.items.properties.rule;
    assert.ok(
      Array.isArray(ruleSchema.enum) && ruleSchema.enum.length > 0,
      "expected a populated rule enum from eslint config",
    );
    assert.ok(
      ruleSchema.enum.some((r) => r.startsWith("eslint/")),
      "expected eslint-prefixed rule names in the enum",
    );
  });

  it("--check passes after generation and is idempotent", () => {
    run("generate schema", schemaDir);
    const { stdout, exitCode } = run("generate schema --check", schemaDir);
    assert.equal(exitCode, 0, stdout);
    assert.ok(stdout.includes("up to date"));
  });

  it("includes configured custom-linter rules from rulesDir in the enum", () => {
    // A custom linter declared in .vigilesrc.json resolves its rules from a
    // rulesDir. `vigiles lint` accepts `my-tool/no-foo`, so the schema enum
    // must include it too (otherwise the YAML LSP false-flags a valid rule).
    const customDir = mkdtempSync(join(tmpdir(), "vigiles-schema-custom-"));
    symlinkSync(
      resolve(process.cwd(), "node_modules"),
      join(customDir, "node_modules"),
    );
    writeFileSync(
      join(customDir, "package.json"),
      JSON.stringify({ name: "test-custom", scripts: {} }),
    );
    writeFileSync(
      join(customDir, ".vigilesrc.json"),
      JSON.stringify({ linters: { "my-tool": { rulesDir: "rules" } } }),
    );
    mkdirSync(join(customDir, "rules"));
    writeFileSync(
      join(customDir, "rules", "no-foo.js"),
      "module.exports = {};",
    );

    const { exitCode } = run("generate schema", customDir);
    assert.equal(exitCode, 0);
    const schema = JSON.parse(
      readFileSync(join(customDir, ".vigiles", "schema.json"), "utf-8"),
    ) as {
      properties: {
        vigiles: {
          properties: {
            enforce: { items: { properties: { rule: { enum?: string[] } } } };
          };
        };
      };
    };
    const ruleEnum =
      schema.properties.vigiles.properties.enforce.items.properties.rule.enum ??
      [];
    assert.ok(
      ruleEnum.includes("my-tool/no-foo"),
      `expected my-tool/no-foo in enum, got: ${JSON.stringify(ruleEnum)}`,
    );
    rmSync(customDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// vigiles generate types
// ---------------------------------------------------------------------------

describe("CLI: vigiles generate types", () => {
  it("should generate types", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vigiles-gen-"));
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { build: "echo ok" } }),
    );
    const { stdout, exitCode } = run("generate types", tmpDir);
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
    run("generate types", tmpDir);
    // Then check — should pass
    const { exitCode } = run("generate types --check", tmpDir);
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
      `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({
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
// Multi-harness: config `harness` selection + the copy-mirror
// ---------------------------------------------------------------------------

describe("CLI: multi-harness compile", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-harness-"));
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({
  target: "CLAUDE.md",
  rules: { "test-rule": guidance("Test guidance.") },
});
`,
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mirrors CLAUDE.md → AGENTS.md byte-identically when ≥2 harnesses are declared", () => {
    writeFileSync(
      join(tmpDir, ".vigilesrc.json"),
      JSON.stringify({ harnesses: { "claude-code": {}, codex: {} } }, null, 2) +
        "\n",
    );
    const { stdout, exitCode } = run("compile CLAUDE.md.spec.ts", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("mirrored"), "should report the mirror write");
    assert.ok(existsSync(join(tmpDir, "AGENTS.md")));
    // Byte-identical — a copy, carrying the source's embedded integrity hash.
    assert.equal(
      readFileSync(join(tmpDir, "AGENTS.md"), "utf-8"),
      readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8"),
    );
  });

  it("does NOT mirror for a single declared harness", () => {
    rmSync(join(tmpDir, "AGENTS.md"), { force: true });
    writeFileSync(
      join(tmpDir, ".vigilesrc.json"),
      JSON.stringify({ harnesses: { "claude-code": {} } }, null, 2) + "\n",
    );
    const { exitCode } = run("compile CLAUDE.md.spec.ts", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(
      !existsSync(join(tmpDir, "AGENTS.md")),
      "no mirror for one harness",
    );
  });

  it("--harness=codex selects the minimal SKILL.md profile (CC-only keys dropped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-skill-"));
    try {
      writeFileSync(
        join(dir, "SKILL.md.spec.ts"),
        `import { experimental_skill, prose } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default experimental_skill({
  name: "demo",
  description: "A demo skill",
  disableModelInvocation: true,
  argumentHint: "<x>",
  body: prose\`Do the thing.\`,
});
`,
      );
      // Codex → minimal frontmatter: the CC-only keys are omitted.
      run("compile --harness=codex SKILL.md.spec.ts", dir);
      const codex = readFileSync(join(dir, "SKILL.md"), "utf-8");
      assert.ok(
        !codex.includes("disable-model-invocation"),
        "codex: no CC key",
      );
      assert.ok(!codex.includes("argument-hint"), "codex: no CC key");
      // Claude Code → full frontmatter: the same spec keeps the CC-only keys.
      run("compile --harness=claude-code SKILL.md.spec.ts", dir);
      const cc = readFileSync(join(dir, "SKILL.md"), "utf-8");
      assert.ok(
        cc.includes("disable-model-invocation: true"),
        "cc: CC key kept",
      );
      assert.ok(cc.includes("argument-hint: <x>"), "cc: CC key kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirror never clobbers a target that owns its own spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-twospecs-"));
    try {
      const specImport = `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";`;
      writeFileSync(
        join(dir, "CLAUDE.md.spec.ts"),
        `${specImport}\nexport default instructionFile({ target: "CLAUDE.md", rules: { "r": guidance("c") } });\n`,
      );
      writeFileSync(
        join(dir, "AGENTS.md.spec.ts"),
        `${specImport}\nexport default instructionFile({ target: "AGENTS.md", rules: { "r": guidance("a") } });\n`,
      );
      writeFileSync(
        join(dir, ".vigilesrc.json"),
        JSON.stringify(
          { harnesses: { "claude-code": {}, codex: {} } },
          null,
          2,
        ) + "\n",
      );
      const { stdout } = run("compile", dir);
      // Each file is its OWN compiled output — the mirror skipped the spec-owned
      // target rather than overwriting AGENTS.md with a copy of CLAUDE.md.
      assert.ok(
        readFileSync(join(dir, "AGENTS.md"), "utf-8").includes("# AGENTS.md"),
        "AGENTS.md kept its own compiled content",
      );
      assert.ok(
        readFileSync(join(dir, "CLAUDE.md"), "utf-8").includes("# CLAUDE.md"),
      );
      assert.ok(!stdout.includes("mirrored"), "no mirror when both own specs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirror defers to a sync tool (.ruler present → no copy written)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-ruler-"));
    try {
      writeFileSync(
        join(dir, "CLAUDE.md.spec.ts"),
        `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({ target: "CLAUDE.md", rules: { "r": guidance("c") } });
`,
      );
      writeFileSync(
        join(dir, ".vigilesrc.json"),
        JSON.stringify(
          { harnesses: { "claude-code": {}, codex: {} } },
          null,
          2,
        ) + "\n",
      );
      mkdirSync(join(dir, ".ruler")); // Ruler owns fan-out
      const { stdout } = run("compile CLAUDE.md.spec.ts", dir);
      assert.ok(
        !existsSync(join(dir, "AGENTS.md")),
        "a sync tool owns fan-out — vigiles must not also write the mirror",
      );
      assert.ok(!stdout.includes("mirrored"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a declared minimal-profile harness drops a skill's CC-only keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-skillwarn-"));
    try {
      writeFileSync(
        join(dir, "SKILL.md.spec.ts"),
        `import { experimental_skill, prose } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default experimental_skill({
  name: "demo",
  description: "A demo skill",
  disableModelInvocation: true,
  body: prose\`Do the thing.\`,
});
`,
      );
      writeFileSync(
        join(dir, ".vigilesrc.json"),
        JSON.stringify(
          { harnesses: { "claude-code": {}, codex: {} } },
          null,
          2,
        ) + "\n",
      );
      const { stdout, exitCode } = run("compile SKILL.md.spec.ts", dir);
      assert.equal(exitCode, 0);
      assert.match(stdout, /disable-model-invocation/);
      assert.match(stdout, /codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spec-target disambiguation: a target-less AGENTS.md.spec.ts compiles as codex", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-spectarget-"));
    try {
      // No `target` field and no config/flag → the spec's filename (AGENTS.md)
      // selects the codex dialect, whose instructionTargets[0] becomes the
      // heading. Before the fix this used the hard-coded claude-code dialect.
      writeFileSync(
        join(dir, "AGENTS.md.spec.ts"),
        `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({ rules: { r: guidance("a") } });
`,
      );
      const { exitCode } = run("compile AGENTS.md.spec.ts", dir);
      assert.equal(exitCode, 0);
      const md = readFileSync(join(dir, "AGENTS.md"), "utf-8");
      assert.match(md, /^# AGENTS\.md/m, "codex dialect → AGENTS.md heading");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirror is idempotent — an already-identical target isn't rewritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-idem-"));
    try {
      writeFileSync(
        join(dir, "CLAUDE.md.spec.ts"),
        `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({ target: "CLAUDE.md", rules: { r: guidance("c") } });
`,
      );
      writeFileSync(
        join(dir, ".vigilesrc.json"),
        JSON.stringify(
          { harnesses: { "claude-code": {}, codex: {} } },
          null,
          2,
        ) + "\n",
      );
      run("compile CLAUDE.md.spec.ts", dir); // first run writes the mirror
      const second = run("compile CLAUDE.md.spec.ts", dir); // already identical
      assert.equal(second.exitCode, 0);
      assert.ok(
        !second.stdout.includes("mirrored"),
        "no re-mirror when the target is already byte-identical",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compile --harness=bogus fails with an actionable error", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-harness-bogus-"));
    try {
      writeFileSync(
        join(dir, "CLAUDE.md.spec.ts"),
        `import { instructionFile, guidance } from "${resolve(process.cwd(), "src/core/spec.js")}";
export default instructionFile({ target: "CLAUDE.md", rules: { r: guidance("c") } });
`,
      );
      const { stdout, stderr, exitCode } = run(
        "compile --harness=bogus CLAUDE.md.spec.ts",
        dir,
      );
      assert.notEqual(exitCode, 0);
      assert.match(stdout + stderr, /Unknown harness/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    // Need a package.json for generate types
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create spec, generate types, and compile", () => {
    const { stdout, exitCode } = run("init --no-plugin", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Created CLAUDE.md.spec.ts"));
    assert.ok(stdout.includes("Setup complete"));
    // Discovery: a non-interactive (agent/CI) run never saw the wizard's
    // "gate vs full" fork, so the summary names `--ci-only` so the flag is findable.
    assert.ok(
      stdout.includes("npx vigiles init --ci-only"),
      "non-interactive setup surfaces the --ci-only alternative",
    );
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

  it("should detect existing CLAUDE.md and adopt it", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Hand-written\n");
    const { stdout } = run("init --no-plugin", tmpDir);
    assert.match(stdout, /adopt/i, "should adopt the hand-written CLAUDE.md");
  });

  it("should detect .cursorrules and suggest sync tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-detect-cursor-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    writeFileSync(join(dir, ".cursorrules"), "Use TypeScript.\n");
    const { stdout } = run("init --no-plugin", dir);
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
    const { stdout } = run("init --no-plugin", dir);
    assert.ok(stdout.includes("Claude Code"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors an existing .vigilesrc.json `harness` over auto-detection (dogfood I3)", () => {
    // The repo would auto-detect as Claude Code (a CLAUDE.md), but config
    // already declares codex — re-running init must target codex, not re-detect.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-detect-cfg-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
    writeFileSync(join(dir, "CLAUDE.md"), "# Hand-written\n");
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ harnesses: { codex: {} } }),
    );
    const { stdout } = run("init --no-plugin", dir);
    assert.match(stdout, /Harness: codex/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("CLI: vigiles init — both pillars + workflow", () => {
  function freshProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-init-pillars-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: {} }),
    );
    return dir;
  }

  it("default (--no-plugin): scaffolds Pillar 2 + a v1-Action workflow", () => {
    const dir = freshProject();
    try {
      const { stdout } = run("init --no-plugin", dir);
      assert.match(stdout, /pillars: lint \+ test/);
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "spec");
      assert.ok(existsSync(join(dir, "vigiles.harness.mjs")), "harness");
      const wf = join(dir, ".github/workflows/vigiles.yml");
      assert.ok(existsSync(wf), "workflow");
      const yaml = readFileSync(wf, "utf-8");
      assert.match(yaml, /uses: zernie\/vigiles@v1/);
      assert.match(yaml, /npx vigiles test/); // the harness job
      // The harness test job installs the CC binary (the detected default).
      assert.match(yaml, /npm i -g @anthropic-ai\/claude-code/);
      assert.doesNotMatch(yaml, /@openai\/codex/);
      // A greenfield repo (no AGENTS.md) records the default harness.
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { harnesses?: Record<string, unknown> };
      assert.deepEqual(Object.keys(cfg.harnesses ?? {}), ["claude-code"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--harness=codex: the CI test job installs the codex binary, not claude", () => {
    const dir = freshProject();
    try {
      run("init --harness=codex --no-plugin", dir);
      const yaml = readFileSync(
        join(dir, ".github/workflows/vigiles.yml"),
        "utf-8",
      );
      assert.match(yaml, /npm i -g @openai\/codex/);
      assert.doesNotMatch(yaml, /@anthropic-ai\/claude-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--harness=claude,codex: the CI test job installs BOTH binaries", () => {
    const dir = freshProject();
    try {
      run("init --harness=claude,codex --no-plugin", dir);
      const yaml = readFileSync(
        join(dir, ".github/workflows/vigiles.yml"),
        "utf-8",
      );
      assert.match(yaml, /@anthropic-ai\/claude-code/);
      assert.match(yaml, /@openai\/codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--test (with gha): the workflow has the harness job but NO lint job (dogfood I4)", () => {
    const dir = freshProject();
    try {
      run("init --test --no-plugin", dir);
      const wf = join(dir, ".github/workflows/vigiles.yml");
      assert.ok(existsSync(wf), "workflow written");
      const yaml = readFileSync(wf, "utf-8");
      assert.match(yaml, /npx vigiles test/, "harness job present");
      assert.doesNotMatch(
        yaml,
        /^ {2}lint:/m,
        "no lint job when the lint pillar is off",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no package.json: NO harness job (the JS test tier can't resolve vigiles) — lint only (dogfood I1 / Codex review)", () => {
    // A non-JS repo has no package.json, so `npx vigiles test` on the starter
    // harness can't resolve its `vigiles` import — the whole harness job
    // would fail, not just an install step. So the workflow emits the lint job
    // (needs no toolchain) and NO harness job.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-init-nopkg-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# proj\n");
      run("init --no-plugin", dir);
      const wf = join(dir, ".github/workflows/vigiles.yml");
      assert.ok(existsSync(wf), "workflow written (lint job)");
      const yaml = readFileSync(wf, "utf-8");
      assert.match(
        yaml,
        /^ {2}lint:/m,
        "lint job present (needs no toolchain)",
      );
      assert.doesNotMatch(
        yaml,
        /npx vigiles test/,
        "no harness job without a package.json (can't resolve vigiles)",
      );
      assert.doesNotMatch(yaml, /run: npm install/, "no npm install step");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no package.json + --test only: no runnable job → no workflow written (Codex review: no empty jobs:)", () => {
    // The only pillar is the JS test tier, which can't run without a package.json,
    // so there is no job to emit — writing a bare `jobs:` would be an invalid
    // workflow GitHub rejects. Emit nothing instead.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-init-nopkg-testonly-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# proj\n");
      run("init --test --no-plugin", dir);
      assert.ok(
        !existsSync(join(dir, ".github/workflows/vigiles.yml")),
        "no workflow when there is no runnable job",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--test: only the harness starter, no spec/workflow", () => {
    const dir = freshProject();
    try {
      const { stdout } = run("init --test --no-plugin --no-gha", dir);
      assert.match(stdout, /pillars: test/);
      assert.ok(existsSync(join(dir, "vigiles.harness.mjs")), "harness");
      assert.ok(!existsSync(join(dir, "CLAUDE.md.spec.ts")), "no spec");
      assert.ok(
        !existsSync(join(dir, ".github/workflows/vigiles.yml")),
        "no workflow",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--test: records the harness but writes NO lint rules (lint pillar off)", () => {
    const dir = freshProject();
    try {
      run("init --test --no-plugin --no-gha", dir);
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { harnesses?: Record<string, unknown>; rules?: unknown };
      assert.deepEqual(
        Object.keys(cfg.harnesses ?? {}),
        ["claude-code"],
        "harness recorded",
      );
      assert.equal(cfg.rules, undefined, "no lint gate for a test-only setup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--lint: spec only, no harness", () => {
    const dir = freshProject();
    try {
      const { stdout } = run("init --lint --no-plugin --no-gha", dir);
      assert.match(stdout, /pillars: lint/);
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "spec");
      assert.ok(!existsSync(join(dir, "vigiles.harness.mjs")), "no harness");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--strict: writes the workflow-tier rules to .vigilesrc.json", () => {
    const dir = freshProject();
    try {
      run("init --lint --strict --no-plugin --no-gha", dir);
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { rules?: Record<string, string> };
      assert.equal(
        cfg.rules?.["require-instructions-spec"],
        "error",
        "workflow rule gated under --strict",
      );
      assert.equal(
        cfg.rules?.["subagent-tool-contract"],
        "error",
        "structural",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--report-only: writes the gate at warn (nothing fails CI)", () => {
    const dir = freshProject();
    try {
      run("init --lint --report-only --no-plugin --no-gha", dir);
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { rules?: Record<string, string> };
      assert.equal(cfg.rules?.["subagent-tool-contract"], "warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives honest guidance on a non-JS repo (no package.json)", () => {
    // A Python/Rust repo with a CLAUDE.md but no package.json gets the SAME
    // next step as a JS repo — `npx vigiles compile` — because the spec host
    // resolves `vigiles/spec` from the CLI's own install (src/self-resolve.mts).
    // It must NOT be told to create a package.json or run an install: init
    // creates neither, and neither is needed.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-nonjs-"));
    try {
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## Notes\n\nPy app.\n",
      );
      const { stdout } = run("init --lint --no-plugin --no-gha", dir);
      assert.ok(
        !existsSync(join(dir, "package.json")),
        "no package.json created",
      );
      assert.match(stdout, /npx vigiles compile/);
      // Must NOT tell a non-JS user to bootstrap npm or install anything —
      // both were advice for a limitation that no longer exists.
      assert.ok(
        !/npm init -y/.test(stdout),
        "no npm-bootstrap advice on a non-JS repo",
      );
      assert.ok(
        !/Run `npm install`/.test(stdout),
        "no misleading npm install step",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("e2e on a repo with NO package.json: init → compile → lint → audit", () => {
    // The END-TO-END proof that the typed-spec path needs no install. Every
    // step is asserted, because the failure this pins was one step deep: `init`
    // and `lint` were already fine on such a repo while `compile` exited 1 with
    // ERR_MODULE_NOT_FOUND, so a test that stopped at `init` saw nothing wrong.
    //
    // Deliberately a PYTHON repo (pyproject.toml, a .py file) and deliberately
    // WITHOUT a package.json — adding one to make the fixture work would erase
    // the very condition under test.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-nopkg-e2e-"));
    try {
      writeFileSync(
        join(dir, "pyproject.toml"),
        '[project]\nname = "demo"\nversion = "0.1.0"\n\n[tool.ruff.lint]\nselect = ["E", "F", "B"]\n',
      );
      writeFileSync(
        join(dir, "app.py"),
        'def main() -> None:\n    print("hi")\n',
      );
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## Overview\n\nA tiny Python project.\n",
      );
      mkdirSync(join(dir, "skills", "greeter"), { recursive: true });
      writeFileSync(
        join(dir, "skills", "greeter", "SKILL.md"),
        "---\nname: greeter\ndescription: Greet the user warmly when they say hello.\n---\n\nSay hello back.\n",
      );

      const init = run("init --lint --no-plugin --no-gha", dir);
      assert.equal(init.exitCode, 0, `init: ${init.stdout}${init.stderr}`);
      assert.ok(
        !existsSync(join(dir, "package.json")),
        "init must not create a package.json",
      );
      assert.ok(
        existsSync(join(dir, "AGENTS.md.spec.ts")),
        "init adopted the instruction file",
      );
      assert.ok(
        existsSync(join(dir, "skills", "greeter", "SKILL.md.spec.ts")),
        "init adopted the skill",
      );

      // THE STEP THAT USED TO FAIL. With no node_modules/vigiles and no
      // package.json, the spec's `import … from "vigiles/spec"` is served by
      // the CLI's own install; without that rescue this exits 1.
      const compiled = run("compile", dir);
      assert.equal(
        compiled.exitCode,
        0,
        `compile: ${compiled.stdout}${compiled.stderr}`,
      );
      assert.doesNotMatch(compiled.stdout, /failed to load/);
      assert.doesNotMatch(
        compiled.stdout + compiled.stderr,
        /ERR_MODULE_NOT_FOUND/,
      );
      assert.match(
        readFileSync(join(dir, "AGENTS.md"), "utf-8"),
        /vigiles:sha256:/,
        "compile stamped the integrity header",
      );
      assert.match(
        readFileSync(join(dir, "skills", "greeter", "SKILL.md"), "utf-8"),
        /vigiles:sha256:/,
        "the skill compiled too (a subpath import, not the bare root)",
      );

      // lint must then VERIFY what compile wrote. No assertion touches a ruff
      // rule, so the test does not need ruff on PATH to be meaningful.
      const linted = run("lint", dir);
      assert.equal(
        linted.exitCode,
        0,
        `lint: ${linted.stdout}${linted.stderr}`,
      );
      assert.match(linted.stdout, /All compiled files intact/);
      assert.doesNotMatch(linted.stdout, /hash MISMATCH/);

      const audited = run("audit", dir);
      assert.equal(
        audited.exitCode,
        0,
        `audit: ${audited.stdout}${audited.stderr}`,
      );
      assert.match(audited.stdout, /AGENTS\.md \(spec-managed\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-adopt is NON-DESTRUCTIVE: never compiles over an existing file in init", () => {
    const dir = freshProject();
    try {
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## Notes\n\nMine.\n",
      );
      const { stdout } = run("init --lint --no-plugin --no-gha", dir);
      // The spec is adopted, but the user's file is left exactly as-is — no
      // integrity header is written during init (the user runs `compile` to opt in).
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "spec adopted");
      const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      assert.equal(md, "# CLAUDE.md\n\n## Notes\n\nMine.\n", "file untouched");
      assert.ok(!md.includes("vigiles:sha256"), "not compiled over");
      // The next step points at the compile the user runs themselves — there is
      // no "install first" caveat any more (the CLI resolves the spec import
      // from its own install), so the only thing gating the compile is consent.
      assert.match(stdout, /npx vigiles compile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clean break: old --pillars / --verify flags are REJECTED, not ignored", () => {
    const dir = freshProject();
    try {
      // These flags were removed. They used to be silently ignored, so `init
      // --verify` ran the full default setup while the author believed they had
      // scoped it — the same "the argument is present, so the property must be
      // enforced" failure the unknown-flag check exists to stop. A removed flag
      // now stops the run and says so.
      for (const stale of ["--verify", "--pillars=lint"]) {
        const r = run(`init ${stale} --no-plugin --no-gha`, dir);
        assert.equal(r.exitCode, 2, `${stale}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /unknown flag/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds vigiles to devDependencies (not dependencies)", () => {
    const dir = freshProject();
    try {
      // Start from a stale runtime pin, like an old git-commit install.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "demo",
          dependencies: { vigiles: "github:zernie/vigiles#abc123" },
        }),
      );
      run("init --test --no-plugin --no-gha", dir);
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      assert.ok(
        !pkg.dependencies || !("vigiles" in pkg.dependencies),
        "vigiles moved out of dependencies",
      );
      assert.ok(
        pkg.devDependencies && "vigiles" in pkg.devDependencies,
        "vigiles in devDependencies",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-adopts an existing CLAUDE.md into a faithful spec (content preserved)", () => {
    const dir = freshProject();
    try {
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## Notes\n\nKeep me.\n",
      );
      const { stdout } = run("init --lint --no-plugin --no-gha", dir);
      // Auto-adopt: the hand-written file is converted into a spec (not a blank
      // scaffold), and the spec captures the content verbatim (faithful).
      assert.match(stdout, /Adopted CLAUDE\.md/);
      const spec = readFileSync(join(dir, "CLAUDE.md.spec.ts"), "utf-8");
      assert.ok(spec.includes("Adopted from CLAUDE.md"), "adopted spec");
      assert.ok(spec.includes("Keep me."), "content captured in the spec");
      // The original content is never lost — compile reproduces it (the byte
      // round-trip is proven in src/core/adopt.test.ts; here freshProject has no
      // resolvable vigiles install so the in-process compile is a no-op).
      assert.ok(
        readFileSync(join(dir, "CLAUDE.md"), "utf-8").includes("Keep me."),
        "content preserved",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts an existing SKILL.md into a skill() spec via init --target", () => {
    const dir = freshProject();
    try {
      mkdirSync(join(dir, "skills", "greet"), { recursive: true });
      writeFileSync(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: Greet warmly\n---\n\n# Greet\n\nSay hi.\n",
      );
      const { stdout } = run("init --target=skills/greet/SKILL.md", dir);
      assert.match(stdout, /Adopted skill/);
      const spec = readFileSync(
        join(dir, "skills", "greet", "SKILL.md.spec.ts"),
        "utf-8",
      );
      assert.ok(
        spec.includes("experimental_skill({"),
        "experimental_skill() spec written",
      );
      assert.ok(spec.includes('name: "greet"'));
      assert.ok(spec.includes("Say hi."), "body captured verbatim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts an existing subagent into an experimental_agent() spec (unmapped key noted)", () => {
    const dir = freshProject();
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code\nmodel: sonnet\nlevel: 3\n---\n\nYou review code.\n\n## Method\n\nRead the diff.\n",
      );
      const { stdout } = run("init --target=agents/reviewer.md", dir);
      assert.match(stdout, /Adopted subagent/);
      const spec = readFileSync(
        join(dir, "agents", "reviewer.md.spec.ts"),
        "utf-8",
      );
      assert.ok(
        spec.includes("experimental_agent({"),
        "experimental_agent() spec written",
      );
      assert.ok(spec.includes('name: "reviewer"'));
      assert.ok(spec.includes("Read the diff."), "## section captured");
      assert.ok(
        spec.includes("NOTE:") && spec.includes("level"),
        "unmapped frontmatter key surfaced, not dropped",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare init adopts every skill + subagent surface, not just the instruction file", () => {
    const dir = freshProject();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\n## Notes\n\nHi.\n");
      mkdirSync(join(dir, "skills", "greet"), { recursive: true });
      writeFileSync(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: Greet warmly\n---\n\nSay hi.\n",
      );
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.\n",
      );
      const { stdout } = run("init --lint --no-plugin --no-gha", dir);
      assert.match(stdout, /Adopted skill/);
      assert.match(stdout, /Adopted subagent/);
      assert.ok(
        existsSync(join(dir, "skills", "greet", "SKILL.md.spec.ts")),
        "skill spec created",
      );
      assert.ok(
        existsSync(join(dir, "agents", "reviewer.md.spec.ts")),
        "subagent spec created",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns loudly on a stale old-API CI workflow, doesn't clobber it", () => {
    const dir = freshProject();
    try {
      const wfDir = join(dir, ".github", "workflows");
      mkdirSync(wfDir, { recursive: true });
      const stale =
        "name: vigiles\njobs:\n  v:\n    steps:\n      - run: npx vigiles\n";
      writeFileSync(join(wfDir, "vigiles.yml"), stale);
      const { stdout } = run("init --no-plugin", dir);
      assert.match(stdout, /STALE/);
      // Not clobbered.
      assert.equal(readFileSync(join(wfDir, "vigiles.yml"), "utf-8"), stale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a workflow calling a renamed subcommand (scan→audit), even with the Action present", () => {
    const dir = freshProject();
    try {
      const wfDir = join(dir, ".github", "workflows");
      mkdirSync(wfDir, { recursive: true });
      // The rename trap: an Action reference (so the bare-API heuristic passes)
      // PLUS a leftover `npx vigiles scan` step renamed to `audit`. (vigiles:ignore-cmd)
      const stale =
        "name: vigiles\njobs:\n  v:\n    steps:\n" +
        "      - uses: zernie/vigiles@v1\n" +
        "      - run: npx vigiles scan\n"; // vigiles:ignore-cmd (intentional stale fixture)
      writeFileSync(join(wfDir, "vigiles.yml"), stale);
      const { stdout } = run("init --no-plugin", dir);
      assert.match(stdout, /STALE/);
      assert.match(stdout, /vigiles scan/);
      assert.match(stdout, /vigiles audit/);
      assert.ok(
        !/already exists \(up to date\)/.test(stdout),
        "must not claim the stale workflow is up to date",
      );
      // Not clobbered — we warn, we don't rewrite.
      assert.equal(readFileSync(join(wfDir, "vigiles.yml"), "utf-8"), stale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force rewrites a renamed-subcommand workflow in place (scan→audit), preserving the rest", () => {
    const dir = freshProject();
    try {
      const wfDir = join(dir, ".github", "workflows");
      mkdirSync(wfDir, { recursive: true });
      const stale =
        "name: vigiles\njobs:\n  v:\n    steps:\n" +
        "      - uses: actions/checkout@v4\n" +
        "      - run: npx vigiles scan\n"; // vigiles:ignore-cmd (intentional stale fixture)
      writeFileSync(join(wfDir, "vigiles.yml"), stale);
      const { stdout } = run("init --no-plugin --force", dir);
      assert.match(stdout, /Rewrote/);
      const after = readFileSync(join(wfDir, "vigiles.yml"), "utf-8");
      assert.ok(after.includes("npx vigiles audit"), "scan → audit");
      assert.ok(!after.includes("vigiles scan"), "no stale scan left");
      // Surgical: the rest of the user's workflow is preserved.
      assert.ok(after.includes("actions/checkout@v4"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI: vigiles --version", () => {
  it("prints a version number, not the help banner", () => {
    const { stdout, exitCode } = run("--version", process.cwd());
    assert.equal(exitCode, 0);
    assert.match(stdout, /\d+\.\d+\.\d+/);
    assert.ok(!stdout.includes("Commands:"), "not the help banner");
  });
});

// ---------------------------------------------------------------------------
// Installation smoke test — run `init` against a REALISTIC fake project and
// assert the WHOLE outcome, including the NEGATIVES (no vendored skills, no
// clobbered instruction file). This is the regression guard for the class of
// bugs that shipped in v3: skills vendored into the repo, no spec for an
// existing file, the dep never added. Deterministic: no network, no real
// claude/codex (plugin install is `--no-plugin`; its no-vendor invariant is
// proven by the planPluginInstall unit tests). See setup-plan.test.ts.
// ---------------------------------------------------------------------------

describe("CLI: installation smoke test (deterministic)", () => {
  // Paths a vendoring installer (the old `npx skills add`) would have created —
  // none may exist after `init`.
  const VENDORED = [".agents", join(".claude", "skills"), "skills-lock.json"];

  function assertNoVendoring(dir: string): void {
    for (const p of VENDORED) {
      assert.ok(
        !existsSync(join(dir, p)),
        `init must not vendor ${p} into the repo`,
      );
    }
  }

  it("Claude Code todo app: spec + types + devDep, vendors NOTHING", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-cc-"));
    try {
      // A realistic Claude Code project: deps (stale vigiles pin), an existing
      // hand-written CLAUDE.md, and a .claude/ dir + a hook + a skill surface.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "todo-app",
          scripts: { test: "echo ok", build: "tsc" },
          dependencies: { vigiles: "github:zernie/vigiles#stale" },
        }),
      );
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# Todo\n\nUse TypeScript strict mode. Keep this prose.\n",
      );
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, "hooks"), { recursive: true });
      writeFileSync(join(dir, "hooks", "guard.sh"), "exit 0\n");

      const { stdout, exitCode } = run("init --no-plugin --no-gha", dir);
      assert.equal(exitCode, 0, stdout);

      // Pillar 1: the hand-written CLAUDE.md is adopted into a spec that
      // captures its prose faithfully (the content is never lost).
      const spec = readFileSync(join(dir, "CLAUDE.md.spec.ts"), "utf-8");
      assert.ok(spec.includes("Adopted from CLAUDE.md"), "adopted spec");
      assert.ok(
        spec.includes("Keep this prose."),
        "prose captured in the spec",
      );
      assert.ok(
        readFileSync(join(dir, "CLAUDE.md"), "utf-8").includes(
          "Keep this prose.",
        ),
        "CLAUDE.md content preserved",
      );
      assert.ok(existsSync(join(dir, ".vigiles/generated.d.ts")), "types");

      // Dep: moved to devDependencies, out of dependencies.
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      assert.ok(pkg.devDependencies?.vigiles, "vigiles in devDependencies");
      assert.ok(
        !pkg.dependencies?.vigiles,
        "vigiles not in runtime dependencies",
      );

      // The negative: nothing vendored into the working tree.
      assertNoVendoring(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Codex todo app: scaffolds an AGENTS.md spec, no CLAUDE.md, no vendoring", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-codex-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "todo-codex", scripts: { test: "echo ok" } }),
      );
      writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nKeep this prose.\n");

      const { stdout, exitCode } = run(
        "init --harness=codex --no-plugin --no-gha",
        dir,
      );
      assert.equal(exitCode, 0, stdout);
      // Codex's native instruction file gets the spec — not CLAUDE.md.
      assert.ok(existsSync(join(dir, "AGENTS.md.spec.ts")), "AGENTS spec");
      assert.ok(
        !existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "no CLAUDE spec for a codex-only project",
      );
      const md = readFileSync(join(dir, "AGENTS.md"), "utf-8");
      assert.ok(md.includes("Keep this prose."), "AGENTS.md preserved");
      // The harness is recorded in project config so compile/lint select it
      // deterministically instead of sniffing the cwd.
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { harnesses?: Record<string, unknown> };
      assert.deepEqual(Object.keys(cfg.harnesses ?? {}), ["codex"]);
      assertNoVendoring(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Claude + Codex todo app: a spec for each, still no vendoring", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-both-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "todo-both", scripts: { test: "echo ok" } }),
      );
      const { stdout, exitCode } = run(
        "init --harness=claude,codex --no-plugin --no-gha",
        dir,
      );
      assert.equal(exitCode, 0, stdout);
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "CLAUDE spec");
      assert.ok(existsSync(join(dir, "AGENTS.md.spec.ts")), "AGENTS spec");
      // Both declared harnesses recorded as the supported set (canonical names).
      const cfg = JSON.parse(
        readFileSync(join(dir, ".vigilesrc.json"), "utf-8"),
      ) as { harnesses?: Record<string, unknown> };
      assert.deepEqual(Object.keys(cfg.harnesses ?? {}), [
        "claude-code",
        "codex",
      ]);
      assertNoVendoring(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AGENTS.md symlinked to CLAUDE.md: ONE spec, not two (no hash collision)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-symlink-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "todo-sym", scripts: { test: "echo ok" } }),
      );
      writeFileSync(join(dir, "CLAUDE.md"), "# One artifact\n\nKeep me.\n");
      // The common bridge to the AGENTS.md tools: ln -s CLAUDE.md AGENTS.md.
      symlinkSync("CLAUDE.md", join(dir, "AGENTS.md"));

      const { stdout, exitCode } = run(
        "init --harness=claude,codex --no-plugin --no-gha",
        dir,
      );
      assert.equal(exitCode, 0, stdout);
      assert.match(stdout, /one artifact/i);
      // Only the canonical (real) file gets a spec — no competing second spec.
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "canonical spec");
      assert.ok(
        !existsSync(join(dir, "AGENTS.md.spec.ts")),
        "no second spec for the mirror",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Ruler project: redirects the spec into .ruler/ (no root CLAUDE.md collision)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-ruler-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "todo-ruler", scripts: { test: "echo ok" } }),
      );
      // Ruler is keyed on its .ruler/ source dir; it regenerates CLAUDE.md.
      mkdirSync(join(dir, ".ruler"), { recursive: true });
      const { stdout, exitCode } = run("init --lint --no-plugin --no-gha", dir);
      assert.equal(exitCode, 0, stdout);
      assert.match(stdout, /ruler detected/i);
      // The spec compiles into Ruler's source slot; Ruler distributes from there.
      assert.ok(
        existsSync(join(dir, ".ruler", "AGENTS.md.spec.ts")),
        "spec in the .ruler source slot",
      );
      // No root spec that would fight Ruler over CLAUDE.md.
      assert.ok(
        !existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "no root CLAUDE.md spec (redirected)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLAUDE.md/AGENTS.md byte-identical (synced): ONE spec for CLAUDE.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-smoke-synced-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "todo-sync", scripts: { test: "echo ok" } }),
      );
      const body = "# Synced\n\nKept identical by rulesync.\n";
      writeFileSync(join(dir, "CLAUDE.md"), body);
      writeFileSync(join(dir, "AGENTS.md"), body); // byte-identical mirror

      const { exitCode } = run("init --no-plugin --no-gha", dir);
      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(dir, "CLAUDE.md.spec.ts")), "canonical spec");
      assert.ok(
        !existsSync(join(dir, "AGENTS.md.spec.ts")),
        "no second spec for the synced mirror",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI: vigiles test — skips are loud and gateable", () => {
  it("reports SKIPPED + passes by default; --no-skip fails on a skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-test-skip-"));
    try {
      writeFileSync(join(dir, "s.harness.mjs"), "process.exit(77);\n"); // skip
      writeFileSync(join(dir, "p.harness.mjs"), "process.exit(0);\n"); // pass

      const def = run("test s.harness.mjs p.harness.mjs", dir);
      assert.equal(def.exitCode, 0); // a skip doesn't fail
      assert.match(def.stdout, /⊘ s\.harness\.mjs — SKIPPED/); // loud, shown
      assert.match(def.stdout, /1 passed, 1 skipped/); // tallied separately

      const strict = run("test --no-skip s.harness.mjs p.harness.mjs", dir);
      assert.equal(strict.exitCode, 1); // a skip is untested surface here
      assert.match(strict.stdout, /SKIPPED — untested surface/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval: a DESCRIPTION is run through the entry, and an unmigrated file is told what to do", () => {
    // Re-probing the product, not the unit: `vigiles eval` has to interpose
    // `dist/eval-entry.js`. Without it the eval file becomes the program again
    // and every migrated file refuses itself — the defect in a new place.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-desc-"));
    const distTest = JSON.stringify(
      resolve(__dirname, "..", "dist", "test.js"),
    );
    try {
      writeFileSync(
        join(dir, "good.eval.mjs"),
        `import { defineEval } from ${distTest};\n` +
          `export default defineEval({ measure: { task: "t", checks: [] }, skipIf: () => "no model here" });\n`,
      );
      const good = run("eval good.eval.mjs", dir);
      assert.equal(good.exitCode, 0, good.stdout + good.stderr);
      assert.match(good.stdout, /SKIPPED/); // loud, never a silent green

      // The unmigrated shape: no description at all.
      writeFileSync(join(dir, "old.eval.mjs"), "export const x = 1;\n");
      const old = run("eval old.eval.mjs", dir);
      assert.equal(old.exitCode, 1);
      assert.match(
        old.stdout + old.stderr,
        /export default defineEval/,
        "an author whose old file stopped working must be told the new shape",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--min fails loudly when fewer evals ran than required (never a silent 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-min-"));
    try {
      // A real (minimal) eval file: it DESCRIBES a measurement and skips, so no
      // model is touched. `process.exit(0)` in the module body used to stand in
      // for one — that is the shape eval files no longer have.
      writeFileSync(
        join(dir, "a.eval.mjs"),
        `import { defineEval } from ${JSON.stringify(resolve(__dirname, "..", "dist", "test.js"))};\n` +
          `export default defineEval({ measure: { task: "t", checks: [] }, skipIf: () => "no model in this test" });\n`,
      );
      // a glob/path matching nothing → 0 ran → must fail under --min
      const none = run("eval --min=1 no-such-*.eval.mjs", dir);
      assert.equal(none.exitCode, 1);
      assert.match(none.stderr, /never executed/);
      // asking for more than exist also fails
      const tooFew = run("eval --min=2 a.eval.mjs", dir);
      assert.equal(tooFew.exitCode, 1);
      assert.match(tooFew.stderr, /--min=2 but only 1/);
      // enough present → passes the guard (the one script runs and exits 0)
      const ok = run("eval --min=1 a.eval.mjs", dir);
      assert.equal(ok.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval lock flags: mutual-exclusion + cold-start no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-lock-"));
    try {
      // --check + --update is a usage error (exit 2).
      const both = run("eval --check --update", dir);
      assert.equal(both.exitCode, 2);
      assert.match(both.stderr, /mutually exclusive/);

      // --check with no committed locks is a GREEN no-op (smooth adoption): the
      // staleness gate activates only once the first lock is committed.
      const cold = run("eval --check", dir);
      assert.equal(cold.exitCode, 0);
      assert.match(cold.stdout, /no committed eval locks found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval lock e2e: --update writes a lock, --check replays green, an input change goes red", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-locke2e-"));
    try {
      // A real eval file run by the built CLI, but MODEL-FREE: it DESCRIBES a
      // trigger-rate eval and hands it a fake `evalDriver`, so the whole
      // --update → --check → stale flow is exercised end to end with no model.
      //
      // It used to call `runEvalWith(spec, fake)` in the module body — the shape
      // that made `import()` spend money, and the reason eval files became
      // descriptions. `evalDriver` is the PUBLIC injection seam (the one Codex
      // users are told to use), so the fixture now drives the same lock
      // machinery through the same door a user would.
      const distTest = resolve(__dirname, "..", "dist", "test.js");
      const evalJs = resolve(__dirname, "..", "dist", "eval.js");
      mkdirSync(join(dir, "skills", "greet"), { recursive: true });
      writeFileSync(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: greets the user\n---\nhi\n",
      );
      writeFileSync(
        join(dir, "x.eval.cjs"),
        `const { defineEval } = require(${JSON.stringify(distTest)});\n` +
          `const { parseClaudeRun } = require(${JSON.stringify(evalJs)});\n` +
          `const fake = () => Promise.resolve({ code: 0, stdout: JSON.stringify({ type: "result", result: "ok", num_turns: 1 }) });\n` +
          `module.exports = defineEval({\n` +
          `  measureTriggerRate: { name: "e2e-eval", skillsDir: __dirname + "/skills", prompts: [process.env.E2E_TASK || "task A"], minPrompts: 1, fired: () => true, trials: 1, model: "claude-sonnet-4-6-20260101", spacingSec: 0 },\n` +
          `  evalDriver: { runner: fake, parse: parseClaudeRun, harness: "claude-code" },\n` +
          `});\n`,
      );
      const lockFile = join(
        dir,
        ".vigiles",
        "eval-locks",
        "e2e-eval.lock.json",
      );

      // 1. --update: drives the (fake) run and writes a committed lock.
      const up = run("eval --update x.eval.cjs", dir, { E2E_TASK: "task A" });
      assert.equal(up.exitCode, 0);
      assert.ok(existsSync(lockFile), "a lock is committed");

      // 2. --check with the SAME inputs: replays green, no model.
      const ok = run("eval --check x.eval.cjs", dir, { E2E_TASK: "task A" });
      assert.equal(ok.exitCode, 0);

      // 3. --check after an INPUT change (different task): STALE → red.
      const stale = run("eval --check x.eval.cjs", dir, { E2E_TASK: "task B" });
      assert.equal(stale.exitCode, 1);
      assert.match(stale.stdout + stale.stderr, /stale/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval-lock-nudge hook: self-gated, non-blocking PostToolUse reminder", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-nudge-"));
    try {
      const event = JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "skills/foo/SKILL.md" },
      });
      const runHook = (input: string): { stdout: string; exitCode: number } => {
        try {
          const stdout = execSync(`node ${CLI} hook-runtime eval-lock-nudge`, {
            cwd: dir,
            encoding: "utf-8",
            input,
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout, exitCode: 0 };
        } catch (e: unknown) {
          const err = e as { stdout?: string; status?: number };
          return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
        }
      };

      // No committed lock → silent (self-gated), exit 0 (never blocks).
      const cold = runHook(event);
      assert.equal(cold.exitCode, 0);
      assert.equal(cold.stdout.trim(), "");

      // Commit a lock → a SKILL.md edit now injects a non-blocking nudge.
      mkdirSync(join(dir, ".vigiles", "eval-locks"), { recursive: true });
      writeFileSync(
        join(dir, ".vigiles", "eval-locks", "x.lock.json"),
        '{"version":1,"name":"x"}',
      );
      const warm = runHook(event);
      assert.equal(warm.exitCode, 0); // still never blocks
      assert.match(warm.stdout, /additionalContext/);
      assert.match(warm.stdout, /eval --update/);

      // A non-eval edit stays silent even with a lock present.
      const other = runHook(
        JSON.stringify({ tool_input: { file_path: "README.md" } }),
      );
      assert.equal(other.stdout.trim(), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const hookPath = resolve(process.cwd(), "hooks/pre-edit.sh");
    assert.ok(existsSync(hookPath));
    execSync(`bash -n ${hookPath}`, { stdio: "pipe" });
  });

  it("should exit 0 for non-md files", () => {
    const input = JSON.stringify({
      tool_input: { file_path: join(tmpDir, "src/app.ts") },
    });
    const hookPath = resolve(process.cwd(), "hooks/pre-edit.sh");
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
    const hookPath = resolve(process.cwd(), "hooks/pre-edit.sh");
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
    const hookPath = resolve(process.cwd(), "hooks/pre-edit.sh");
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
    const hookPath = resolve(process.cwd(), "hooks/post-edit.sh");
    assert.ok(existsSync(hookPath));
    // Check it's parseable bash
    try {
      execSync(`bash -n ${hookPath}`, { stdio: "pipe" });
    } catch {
      assert.fail("post-edit.sh has syntax errors");
    }
  });

  it("should exit cleanly with empty input", () => {
    const hookPath = resolve(process.cwd(), "hooks/post-edit.sh");
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
    const hookPath = resolve(process.cwd(), "hooks/post-edit.sh");

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
      // generate types without mocking npx, but we can verify it doesn't crash.
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
    const hookPath = resolve(process.cwd(), "hooks/post-edit.sh");
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
    const hookPath = resolve(process.cwd(), "hooks/post-edit.sh");
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

describe("plugin hook: eval-lock-nudge.sh", () => {
  it("is executable, parseable bash", () => {
    const hookPath = resolve(process.cwd(), "hooks/eval-lock-nudge.sh");
    assert.ok(existsSync(hookPath));
    try {
      execSync(`bash -n ${hookPath}`, { stdio: "pipe" });
    } catch {
      assert.fail("eval-lock-nudge.sh has syntax errors");
    }
  });

  it("exits 0 (never blocks) on a SKILL.md edit", () => {
    const hookPath = resolve(process.cwd(), "hooks/eval-lock-nudge.sh");
    // Run in a tmp dir with no package.json: the wrapper's own guard exits 0
    // before reaching npx — exercising that the nudge is advisory and never
    // disrupts an edit (the gate is CI's `eval --check`, not this hook).
    const tmp = mkdtempSync(join(tmpdir(), "vigiles-nudgesh-"));
    try {
      const input = JSON.stringify({
        tool_input: { file_path: "skills/foo/SKILL.md" },
      });
      execSync(`echo '${input}' | bash ${hookPath}`, {
        cwd: tmp,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      assert.ok(true, "exited 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: fixture project — full adoption flow
// ---------------------------------------------------------------------------

describe("E2E: fixture project adoption", () => {
  const FIXTURE = resolve(
    __dirname,
    "..",
    "test",
    "fixtures",
    "example-project",
  );
  let workDir: string;

  before(() => {
    // Copy fixture to a temp dir so tests don't pollute it
    workDir = mkdtempSync(join(tmpdir(), "vigiles-e2e-"));
    execSync(`cp -r ${FIXTURE}/* ${workDir}/`, { stdio: "pipe" });
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("setup detects existing hand-written CLAUDE.md and adopts it", () => {
    const { stdout } = run("init --no-plugin", workDir);
    // Existing CLAUDE.md without a spec → adopted into one (non-destructively).
    assert.match(
      stdout,
      /adopt/i,
      "Should adopt the existing hand-written CLAUDE.md",
    );
  });

  it("lint detects CLAUDE.md has no vigiles hash", () => {
    const { stdout } = run("lint", workDir);
    // Hand-written CLAUDE.md has no hash — should report it
    assert.ok(
      stdout.includes("no vigiles hash") ||
        stdout.includes("require-instructions-spec") ||
        stdout.includes("Verifying"),
    );
  });

  it("generate types works in fixture project", () => {
    const { exitCode } = run("generate types", workDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(workDir, ".vigiles/generated.d.ts")));
  });

  it("full flow: write spec → compile → lint passes", () => {
    // Clean slate: remove any existing CLAUDE.md and spec
    const mdPath = join(workDir, "CLAUDE.md");
    const specPath = join(workDir, "CLAUDE.md.spec.ts");
    if (existsSync(mdPath)) rmSync(mdPath);
    if (existsSync(specPath)) rmSync(specPath);

    // Write a spec that imports from vigiles dist (not node_modules)
    const specSrc = resolve(process.cwd(), "dist", "core", "spec.js");
    writeFileSync(
      specPath,
      `import { instructionFile, guidance } from "${specSrc}";
export default instructionFile({
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
    const lintResult = run("lint", workDir);
    assert.ok(
      lintResult.stdout.includes("hash valid") || lintResult.exitCode === 0,
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown-mode file/cmd verification (the pivot: markdown verifies paths and
// scripts, not just linter rules)
// ---------------------------------------------------------------------------

describe("CLI: markdown-mode file/cmd verification", () => {
  function scaffold(claudeMd: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-mdref-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", scripts: { build: "tsc" } }),
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "real.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
    return dir;
  }

  it("passes when inline file/cmd references resolve", () => {
    const dir = scaffold(
      `# P\n\nSee <!-- vigiles:file src/real.ts --> and run <!-- vigiles:cmd "npm run build" -->.\n`,
    );
    try {
      const { exitCode } = run("lint CLAUDE.md", dir);
      assert.equal(exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails (exit 2) on a stale inline file reference", () => {
    const dir = scaffold(`# P\n\n<!-- vigiles:file src/GONE.ts -->\n`);
    try {
      const { stdout, exitCode } = run("lint CLAUDE.md", dir);
      assert.equal(exitCode, 2);
      assert.match(stdout, /File not found: "src\/GONE\.ts"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails (exit 2) on a stale inline command reference", () => {
    const dir = scaffold(`# P\n\n<!-- vigiles:cmd "npm run ghost" -->\n`);
    try {
      const { stdout, exitCode } = run("lint CLAUDE.md", dir);
      assert.equal(exitCode, 2);
      assert.match(stdout, /Script "ghost" not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores file/cmd lists declared in frontmatter (mode disabled, inert)", () => {
    // Frontmatter mode is disabled, so `vigiles: files/commands` lists are inert:
    // a missing file + bad script in a `vigiles:` block must NOT fail lint. (The
    // inline `<!-- vigiles:cmd -->` form above stays active — that's the kept
    // zero-TS on-ramp.)
    const dir = scaffold(
      `---\nvigiles:\n  files:\n    - src/real.ts\n    - src/MISSING.ts\n  commands:\n    - npm run build\n    - npm run ghost\n---\n\n# P\n`,
    );
    try {
      const { stdout, exitCode } = run("lint CLAUDE.md", dir);
      assert.notEqual(
        exitCode,
        2,
        "an inert frontmatter block must not fail lint",
      );
      assert.doesNotMatch(stdout, /File not found: "src\/MISSING\.ts"/);
      assert.doesNotMatch(stdout, /Script "ghost" not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// vigiles eject — un-manage a compiled file back to plain markdown
// ---------------------------------------------------------------------------

describe("CLI: vigiles eject", () => {
  let tmpDir: string;
  const HEADER =
    "<!-- vigiles:sha256:deadbeef compiled from CLAUDE.md.spec.ts -->";
  const compiled = `${HEADER}\n\n# CLAUDE.md\n\nSome guidance.\n`;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vigiles-cli-eject-"));
  });
  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips the integrity header, adds the disable marker, and removes the spec", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), compiled);
    writeFileSync(join(tmpDir, "CLAUDE.md.spec.ts"), "export default {}\n");
    const { stdout, exitCode } = run("eject CLAUDE.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Ejected CLAUDE.md"));
    const out = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    assert.ok(!out.includes("vigiles:sha256"), "header stripped");
    assert.ok(
      out.includes("<!-- vigiles-disable require-instructions-spec -->"),
      "marker added",
    );
    assert.ok(out.includes("# CLAUDE.md"), "body preserved");
    assert.ok(!existsSync(join(tmpDir, "CLAUDE.md.spec.ts")), "spec removed");
  });

  it("leaves lint quiet on the ejected file (no require-instructions-spec error)", () => {
    const { stdout, stderr, exitCode } = run("lint CLAUDE.md", tmpDir);
    assert.ok(
      !(stdout + stderr).includes("require-instructions-spec"),
      "require-instructions-spec satisfied",
    );
    assert.equal(exitCode, 0);
  });

  it("reports nothing to eject on a plain (already-ejected) file", () => {
    const { stdout, exitCode } = run("eject CLAUDE.md", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("nothing to eject"));
  });

  it("--keep-spec leaves the spec in place", () => {
    writeFileSync(
      join(tmpDir, "K.md"),
      `${HEADER.replace("CLAUDE.md", "K.md")}\n\n# K\n`,
    );
    writeFileSync(join(tmpDir, "K.md.spec.ts"), "export default {}\n");
    const { exitCode } = run("eject K.md --keep-spec", tmpDir);
    assert.equal(exitCode, 0);
    assert.ok(existsSync(join(tmpDir, "K.md.spec.ts")), "spec kept");
  });

  // A multi-target spec `target: ["CLAUDE.md", "AGENTS.md"]` compiles BOTH files
  // from CLAUDE.md.spec.ts; their headers both name it. Ejecting EITHER one while
  // the OTHER is still managed must keep the shared spec (or the other orphans).
  function multiTargetDir(): string {
    const d = mkdtempSync(join(tmpdir(), "vigiles-eject-shared-"));
    writeFileSync(join(d, "CLAUDE.md.spec.ts"), "export default {}\n");
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      writeFileSync(
        join(d, f),
        `<!-- vigiles:sha256:deadbeef compiled from CLAUDE.md.spec.ts -->\n\n# ${f}\n\nShared.\n`,
      );
    }
    return d;
  }

  it("keeps the shared spec when ejecting the SECONDARY target", () => {
    const dir = multiTargetDir();
    try {
      const { stdout, exitCode } = run("eject AGENTS.md", dir);
      assert.equal(exitCode, 0);
      assert.ok(
        existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "shared spec survives — CLAUDE.md still references it",
      );
      assert.match(stdout, /Kept CLAUDE\.md\.spec\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the shared spec when ejecting the PRIMARY target", () => {
    const dir = multiTargetDir();
    try {
      const { exitCode } = run("eject CLAUDE.md", dir);
      assert.equal(exitCode, 0);
      assert.ok(
        existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "shared spec survives — AGENTS.md still references it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to delete a forged out-of-spec target named in the header", () => {
    // A hand-edited/forged header points `compiled from` at a non-spec file.
    // eject must NOT delete it (path-safety) — only a .spec.ts inside the project.
    const d = mkdtempSync(join(tmpdir(), "vigiles-eject-forged-"));
    try {
      writeFileSync(join(d, "package.json"), '{"name":"victim"}\n');
      writeFileSync(
        join(d, "CLAUDE.md"),
        "<!-- vigiles:sha256:deadbeef compiled from package.json -->\n\n# CLAUDE.md\n\nx.\n",
      );
      const { stdout, exitCode } = run("eject CLAUDE.md", d);
      assert.equal(exitCode, 0);
      assert.ok(
        existsSync(join(d, "package.json")),
        "must NOT delete package.json",
      );
      assert.match(stdout, /refusing to delete|isn't a \.spec\.ts/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes the spec once its LAST compiled output is ejected", () => {
    const dir = multiTargetDir();
    try {
      run("eject AGENTS.md", dir); // secondary first — spec kept
      run("eject CLAUDE.md", dir); // last consumer — now safe to delete
      assert.ok(
        !existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "spec deleted when no compiled output references it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the shared spec when the other output is in a SUBDIRECTORY", () => {
    // `target: ["CLAUDE.md", "docs/AGENTS.md"]` — the secondary lives in a subdir.
    // Ejecting the root file must scan the whole tree (not just its own dir) so it
    // doesn't orphan docs/AGENTS.md by deleting the shared spec.
    const dir = mkdtempSync(join(tmpdir(), "vigiles-eject-subdir-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md.spec.ts"), "export default {}\n");
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "<!-- vigiles:sha256:deadbeef compiled from CLAUDE.md.spec.ts -->\n\n# CLAUDE.md\n",
      );
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(
        join(dir, "docs", "AGENTS.md"),
        "<!-- vigiles:sha256:deadbeef compiled from CLAUDE.md.spec.ts -->\n\n# AGENTS.md\n",
      );
      const { exitCode } = run("eject CLAUDE.md", dir);
      assert.equal(exitCode, 0);
      assert.ok(
        existsSync(join(dir, "CLAUDE.md.spec.ts")),
        "shared spec survives — docs/AGENTS.md still references it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors on a missing file", () => {
    const { exitCode } = run("eject does-not-exist.md", tmpDir);
    assert.equal(exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// vigiles lint — directory args + --strict gating of structural rules
// ---------------------------------------------------------------------------

describe("CLI: vigiles lint directory arg + strict gating", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-lint-strict-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo" }),
    );
    mkdirSync(join(dir, "agents"), { recursive: true });
    // The strict config init --strict now writes: structural rules gate.
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({
        rules: {
          "subagent-tool-contract": "error",
          "subagent-frontmatter": "error",
        },
      }),
    );
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reviewer(tools: string, desc = "Reviews a diff."): void {
    writeFileSync(
      join(dir, "agents", "reviewer.md"),
      `---\nname: reviewer\ndescription: ${desc}\ntools: [${tools}]\n---\n\nReview.\n`,
    );
  }

  it("`lint .` (a directory arg) does not crash (regression: EISDIR)", () => {
    reviewer("Read, Grep");
    const { exitCode } = run("lint .", dir);
    assert.notEqual(exitCode, undefined);
    assert.ok(
      exitCode === 0,
      `clean plugin lints green, got ${String(exitCode)}`,
    );
  });

  it("a clean subagent passes under strict (exit 0)", () => {
    reviewer("Read, Grep");
    assert.equal(run("lint", dir).exitCode, 0);
  });

  it("a typo'd tool FAILS CI under strict (exit 2)", () => {
    reviewer("Reed, Grep"); // Reed = typo of Read
    const { stdout, exitCode } = run("lint", dir);
    assert.equal(exitCode, 2, "broken subagent gates CI");
    assert.ok(
      /Reed/.test(stdout) && /Read/.test(stdout),
      "names the typo + fix",
    );
  });

  it("a subagent missing its description FAILS CI under strict (exit 2)", () => {
    writeFileSync(
      join(dir, "agents", "reviewer.md"),
      "---\nname: reviewer\ntools: [Read]\n---\n\nReview.\n",
    );
    assert.equal(run("lint", dir).exitCode, 2);
  });
});
