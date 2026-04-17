/**
 * CLAUDE.md specification for the vigiles project.
 *
 * This is the source of truth. CLAUDE.md is a compiled build artifact.
 * Run `npm run compile:spec` to regenerate CLAUDE.md from this spec.
 */
import { claude, enforce, guidance } from "./src/spec.js";

export default claude({
  sections: {
    positioning: `vigiles compiles \`.spec.ts\` files to instruction files (CLAUDE.md, AGENTS.md, or any markdown target). The spec is the source of truth. The markdown is a build artifact. Nobody else does this — other tools lint markdown after the fact. vigiles eliminates the problem at the source.

The linter cross-referencing engine is the core moat: \`enforce("@typescript-eslint/no-floating-promises")\` verifies the rule exists AND is enabled in your linter config. Same for ESLint, Ruff, Clippy, Pylint, RuboCop, and Stylelint. No other tool resolves rules against 6 linter APIs.

\`generate-types\` is the second moat: scans all 6 linter APIs, package.json, and project files to emit a \`.d.ts\` with type unions. The TS compiler then PROVES references are valid at authoring time — typos become type errors, not runtime surprises.

vigiles does NOT do architectural linting. Use ast-grep, Dependency Cruiser, Steiger, or eslint-plugin-boundaries for that. vigiles can reference their rules via \`enforce()\`.`,

    architecture: `Two rule types in specs:

- \`enforce()\` — delegated to external tool (linter, ast-grep, dependency-cruiser). vigiles verifies the rule exists and is enabled.
- \`guidance()\` — prose only, compiles to \`**Guidance only**\` in markdown.

Architectural linting (file pairing, import boundaries, AST patterns) belongs in external tools — reference them via \`enforce()\`.

Template literal types ensure linter names (\`eslint/\`, \`ruff/\`, etc.) are type-safe. Branded types (\`VerifiedPath\`, \`VerifiedCmd\`, \`VerifiedRef\`) distinguish verified references from raw strings.

Compilation: spec.ts → compiler reads spec, validates references (file paths via existsSync, npm scripts via package.json, linter rules via linter APIs), generates markdown with SHA-256 integrity hash.

Core modules: \`src/spec.ts\` (types + builders), \`src/compile.ts\` (compiler), \`src/linters.ts\` (6-linter cross-referencing engine), \`src/generate-types.ts\` (type generator), \`src/proofs.ts\` (proof algorithms for self-evolving specs), \`src/evolve.ts\` (evolution engine).`,
  },

  keyFiles: {
    "src/spec.ts":
      "Type system and builder functions (enforce, guidance, claude, skill, file, cmd, ref)",
    "src/compile.ts":
      "Compiler: spec → markdown with SHA-256 hash, linter verification, reference validation",
    "src/linters.ts":
      "Linter cross-referencing engine (ESLint, Stylelint, Ruff, Clippy, Pylint, RuboCop)",
    "src/generate-types.ts":
      "Type generator: scans linters/package.json/filesystem → emits .d.ts",
    "src/cli.ts":
      "CLI: init, compile, audit (3 primary commands + generate-types plumbing)",
    "src/inline.ts":
      "Inline-mode parser: `<!-- vigiles:enforce ... -->` comments in markdown for gradual adoption",
    "src/action.ts": "GitHub Action wrapper",
    "src/spec.test.ts": "Spec + compiler test suite (node:test)",
    "src/validate.test.ts": "Validation test suite (node:test)",
    "src/cli.test.ts": "CLI integration + E2E test suite (node:test)",
    "src/freshness.ts":
      "Freshness detection: lock file detection, input discovery, hash computation, sidecar manifests, affected-specs",
    "src/freshness.test.ts":
      "Freshness test suite: lock files (15 ecosystems), input discovery, hash computation, sidecar manifests, affected-specs",
    "src/coverage.ts":
      "Spec coverage analysis: linter rule coverage + npm script coverage with configurable thresholds",
    "src/coverage.test.ts": "Coverage test suite (node:test)",
    "src/session.ts":
      "Post-session audit: git diff analysis against spec surface area",
    "src/session.test.ts": "Session audit test suite (node:test)",
    "src/drift.ts":
      "Drift integration: detect when code anchored by specs has changed (Fiberplane Drift)",
    "src/drift.test.ts": "Drift test suite (node:test)",
    "src/types.ts":
      "Shared types: RulesConfig, VigilesConfig, FreshnessMode, CoverageThresholds",
    "src/proofs.ts":
      "Deterministic proof algorithms (monotonicity lattice, NCD, Bloom filter, Merkle DAG, fixed-point, property testing)",
    "src/evolve.ts":
      "Evolution engine: mutation operators, fitness function, proof-gated selection",
    "src/proofs.test.ts": "Proof system + evolution engine tests (node:test)",
    "CLAUDE.md.spec.ts": "This file — the source of truth for CLAUDE.md",
    "examples/SKILL.md.spec.ts": "Example SKILL.md spec",
    "research/adoption-strategy.md":
      "Adoption strategy: zero-config setup, progressive enforcement, agent workflows",
    "research/competitive-landscape.md":
      "Competitive landscape: rule-porter, rulesync, vibe-cli, Ruler",
    "research/executable-specs.md": "Design doc: executable spec system",
    "research/feature-ideas.md":
      "Feature ideas: plugin API, custom rules, exhaustive coverage",
    "research/ai-code-quality.md": "Research: AI code quality patterns",
    "research/self-evolving-specs.md":
      "Design doc: self-evolving spec system (proofs, Merkle history, evolution engine)",
    "research/code-search-for-agents.md":
      "Research: code search approaches (grep vs embeddings vs AST-grep)",
    "research/doc-freshness.md":
      "Research: input fingerprinting, TOC manifests, stale spec detection, competitive landscape, build-vs-adopt analysis",
    "research/runtime-enforcement.md":
      "Research: spec-derived runtime enforcement via hooks, skill contracts, session audit",
    "research/architecture-platform.md":
      "Research: architecture-aware agent platform (FSD/DDD/hexagonal presets, meta-validation)",
    "research/formal-proofs-for-agents.md":
      "Research: formal verification via Lean 4 / Dafny, Cedar pattern, Leanstral integration",
    "docs/agent-workflows.md":
      "Agent-specific workflows (Claude Code, Codex, multi-agent, Cursor)",
    "docs/agent-setup.md":
      "Non-interactive agent setup guide (hooks via settings.json)",
    "docs/spec-format.md": "Spec format reference (target, sections, rules)",
    "docs/linter-support.md":
      "Linter support details (6 linters + generate-types)",
    "docs/comparison.md":
      "Before/after tables (Claude Code, Codex), determinism breakdown, flow diagram",
    "docs/freshness.md":
      "Freshness detection: strict/input-hash/output-hash modes, lock file detection, input fingerprinting",
    "docs/inline-mode.md":
      "Inline mode: `<!-- vigiles:enforce ... -->` comments for gradual adoption without a .spec.ts",
    "skills/linter-docs/eslint.md":
      "ESLint reference: plugin table, AST selectors, type-aware rules, auto-fix, edge cases",
    "skills/linter-docs/rubocop.md":
      "RuboCop reference: gem table, node pattern DSL, auto-correct, custom cops",
    "skills/linter-docs/pylint.md":
      "Pylint reference: plugin table, astroid AST, type inference, custom checkers",
    "skills/linter-docs/ruff.md":
      "Ruff reference: 800+ reimplemented rules, rule selection, auto-fix, pyproject.toml config",
    "skills/linter-docs/stylelint.md":
      "Stylelint reference: plugin table, PostCSS AST, custom rules, CSS-in-JS, SCSS",
    "skills/strengthen/SKILL.md":
      "Strengthen skill: upgrade guidance() → enforce() by finding existing linter rules",
  },

  commands: {
    "npm run build": "Compile TypeScript to dist/",
    "npm test": "Build and run all tests",
    "npm run fmt": "Format with prettier",
    "npm run fmt:check": "Check formatting",
    "npm run lint": "Run ESLint on src/",
  },

  rules: {
    "no-non-null-assertion": enforce(
      "@typescript-eslint/no-non-null-assertion",
      "Use proper narrowing instead of ! assertions.",
    ),

    "no-floating-promises": enforce(
      "@typescript-eslint/no-floating-promises",
      "Always await or return promises. Unhandled rejections crash the process.",
    ),

    "cognitive-complexity": enforce(
      "sonarjs/cognitive-complexity",
      "Keep functions under 15 cognitive complexity. Split complex logic into helpers.",
    ),

    "never-skip-tests": guidance(
      "All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.",
    ),

    "zero-config-by-default": guidance(
      "`vigiles compile` should work with just a .spec.ts file. Config exists only for overrides (maxRules, maxTokens).",
    ),

    "dont-reimplement-linters": guidance(
      "Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger. Per-file code rules belong in ESLint/Ruff/Clippy. vigiles owns: spec compilation, linter cross-referencing, type generation, stale reference detection, and proof-based spec evolution.",
    ),

    "smooth-adoption": guidance(
      "`npx vigiles init && npx skills add zernie/vigiles` must work on first run with zero config. The wizard auto-detects the project, creates specs, generates types, compiles, and wires CI. After install the agent edits specs automatically — no workflow change required. Start permissive (guidance rules, `require-spec: false` available), tighten over time. Hesitant adopters can use inline mode (`<!-- vigiles:enforce ... -->` comments) without a .spec.ts — see `docs/inline-mode.md`. See `research/adoption-strategy.md`.",
    ),

    "format-before-commit": guidance(
      "Run `npm run fmt:check` before committing. Inline code spans in markdown need surrounding spaces to render correctly.",
    ),

    "progressive-adoption": guidance(
      "vigiles must be adoptable incrementally, like TypeScript. Three on-ramps, zero friction: (1) inline mode — add `<!-- vigiles:enforce ... -->` comments to an existing CLAUDE.md, no new files; (2) spec mode with `guidance()` only — `npx vigiles init` creates a .spec.ts, compiles to markdown, zero linter setup; (3) strict mode — `enforce()` rules, CI gating, `--strict` flag. Each level adds value without requiring the next. Never gate basic functionality on advanced setup. README examples should always show the simplest path first.",
    ),

    "no-session-links": guidance(
      "This is a public repo. Claude Code session URLs are private and must not appear in commits or PRs.",
    ),

    "readme-brevity": guidance(
      "README.md should be a concise pitch + quick start, not a reference manual. Extract detailed sections into docs/ and link with `[Details →](docs/X.md)`. Target ~300 lines max.",
    ),
  },
});
