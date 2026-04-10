/**
 * Example: CLAUDE.md specification for the vigiles project itself.
 *
 * This is the source of truth. CLAUDE.md is a compiled build artifact.
 * Run `vigiles compile` to generate CLAUDE.md from this spec.
 */
import { claude, enforce, guidance, check, every } from "../src/spec.js";

export default claude({
  sections: {
    positioning: `vigiles compiles \`.spec.ts\` files to instruction files. The spec is the source of truth. The markdown is a build artifact.

The linter cross-referencing engine is the core moat: \`enforce("eslint/no-console")\` verifies the rule exists AND is enabled in your ESLint config. Same for Ruff, Clippy, Pylint, RuboCop, and Stylelint.

\`generate-types\` is the second moat: scans all 6 linter APIs, package.json, and project files to emit a \`.d.ts\` with type unions. The TS compiler then PROVES references are valid at authoring time.`,

    architecture: `Three rule types in specs: \`enforce()\` (delegated to external tool), \`check()\` (vigiles-owned filesystem assertion), \`guidance()\` (prose only).

Core modules: \`src/spec.ts\` (types + builders), \`src/compile.ts\` (compiler), \`src/linters.ts\` (6-linter cross-referencing engine), \`src/generate-types.ts\` (type generator).`,
  },

  keyFiles: {
    "src/spec.ts": "Type system and builder functions",
    "src/compile.ts": "Compiler: spec → markdown with SHA-256 hash",
    "src/linters.ts": "Linter cross-referencing engine (6 linters)",
    "src/generate-types.ts": "Type generator: project state → .d.ts",
    "src/cli.ts": "CLI: compile, check, init, generate-types, discover, adopt",
  },

  commands: {
    "npm run build": "Compile TypeScript to dist/",
    "npm test": "Build and run all tests",
    "npm run fmt": "Format with prettier",
    "npm run fmt:check": "Check formatting",
  },

  rules: {
    "zero-config-by-default": guidance(
      "vigiles compile should work with just a .spec.ts file. Config exists only for overrides (maxRules, maxTokens, catalogOnly).",
    ),

    "never-skip-tests": guidance(
      "All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.",
    ),

    "dont-reimplement-linters": guidance(
      "Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger. Per-file code rules belong in ESLint/Ruff/Clippy. vigiles owns: compilation, linter cross-referencing, type generation, filesystem assertions, and stale reference detection.",
    ),

    "format-before-commit": guidance(
      "Run `npm run fmt:check` before committing. Inline code spans in markdown need surrounding spaces to render correctly.",
    ),

    "no-session-links": guidance(
      "This is a public repo. Claude Code session URLs are private and must not appear in commits or PRs.",
    ),

    "test-file-pairing": check(
      every("src/**/*.ts").has("{name}.test.ts"),
      "Every source module should have a corresponding test file.",
    ),
  },
});
