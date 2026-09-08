import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";

import experimentalName from "./eslint-rules/experimental-name.mjs";

// The repo's own rules. One member so far — see the rule's header for why it is
// a rule and not the standalone script it replaces (short version: the script
// hand-rolled a parser over declaration lines, and its one cross-file need, the
// public/internal exemption, was itself the thing contradicting its rationale).
const local = { rules: { "experimental-name": experimentalName } };

// Hexagonal boundary (see research/code-adapter-architecture.md). After the
// reshape the two element types are whole directories: the reference-verification
// DOMAIN lives in src/core/, the Claude Code harness/transport ADAPTER in
// src/adapters/claude-code/. The application/barrel layer (cli, scan, the
// test/eval barrels, action) stays at src/ root, unclassified —
// it's the composition root, allowed to wire adapter to core. The invariant: the
// domain must never import the adapter, so the core stays harness-agnostic for a
// future src/adapters/<other-harness>. Holds today with zero violations.
const VERIFY_CORE = "src/core/**/*.ts";
// The Claude Code adapter. `src/mock-model.ts` is the Anthropic-Messages SSE mock
// — Claude-Code-specific in CONTENT even though it sits at the src/ root, so it is
// classified as part of the CC adapter here. That makes the import-graph boundary
// rule below FORBID the agnostic surface from re-exporting it (the leak that let
// `scriptModel` surface from the root testing barrel); get the CC mock from
// `vigiles/claude-code` instead. (The principled end-state is to physically move
// the file under src/adapters/claude-code/ — tracked in research/roadmap.md — but
// classifying it enforces the invariant today, with no move required.)
const CC_HARNESS = ["src/adapters/claude-code/**/*.ts", "src/mock-model.ts"];
const CODEX_HARNESS = "src/adapters/codex/**/*.ts";
const OPENCODE_HARNESS = "src/adapters/opencode/**/*.ts";
// The harness-AGNOSTIC public surface: the two testing barrels, split on COST —
// `src/test.ts` (the package root: everything free) and `src/eval-surface.ts`
// (`vigiles/eval`: everything that can call a model). They advertise themselves as
// harness-agnostic, so they must route through the composition-root runner modules
// (src/{harness-test,run-hook,eval}.ts) and may re-export ONLY the agnostic names
// from them — never the Claude-Code transport (`scriptModel`, `claudeCodeDriver`,
// `loadPlugin`, …), and never a specific adapter. Otherwise "agnostic" is a name
// only. See research/adapter-api-design.md.
const AGNOSTIC_SURFACE = "src/{test,eval-surface}.ts";

// The harness-agnostic DOMAIN + the reference-verification DETECTORS — these take
// a PluginLayout / HarnessDialect by injection, so they must NOT hard-code a
// Claude Code literal (the bug class fixed in scan.ts/test-coverage.ts: a
// `${CLAUDE_PLUGIN_ROOT}` token or a `.claude/` surface path baked in instead of
// read from the layout). The CC adapter, the CC eval transport (src/eval.ts), and
// the CC plugin onboarding (init in src/cli-main.ts) legitimately reference CC, so they
// are NOT in this set. Complements the import-graph boundary with a string-literal
// boundary. See research/code-adapter-architecture.md.
const HARNESS_AGNOSTIC_DETECTORS = [
  "src/core/**/*.ts",
  "src/scan.ts",
  "src/test-coverage.ts",
  "src/plugin-loader.ts",
];
const CC_LITERAL_RE = "CLAUDE_PLUGIN_ROOT|\\.claude|ANTHROPIC_";
const CC_LITERAL_MSG =
  "Harness-agnostic code must not hard-code a Claude Code literal " +
  "(${CLAUDE_PLUGIN_ROOT}, .claude/, ANTHROPIC_*). Read it from the injected " +
  "PluginLayout / HarnessDialect instead — e.g. layout.pluginRootToken, " +
  "layout.skillDir / agentDir / commandDir, layout.materializeRoot, " +
  "layout.manifestPath. CC literals belong only in src/adapters/claude-code/ " +
  "(or the CC-specific eval transport). See research/code-adapter-architecture.md.";

/** The discovery-boundary selectors (see the block that uses them, below). */
const DISCOVERY_SELECTORS = [
  {
    selector:
      'CallExpression[callee.name="globSync"]:not(:has(Property[key.name="ignore"]))',
    message:
      "globSync without an `ignore` walks the user's repo with no exclusion at all. " +
      "Pass the ExcludeSet from src/exclude.ts (`ignore: excludes.globIgnore` for a " +
      "glob that may be rooted below the repo, `excludes.ignore` for one rooted at it).",
  },
  {
    selector:
      'CallExpression[callee.name="globSync"] Property[key.name="ignore"] > ArrayExpression > Literal',
    message:
      "A hard-coded ignore list is the #192 bug shape — it silently drops " +
      ".vigilesrc.json#exclude. Build the list from the ExcludeSet (src/exclude.ts).",
  },
];

export default [
  {
    // `src/*.md.spec.ts` (nested instruction-file specs) are excluded from
    // tsconfig to avoid a dist-path collision with the root spec, so the
    // type-aware project service can't resolve them — eslint-ignore to match
    // (they're tsx-loaded build inputs, like the root CLAUDE.md.spec.ts, not
    // part of the typed source).
    ignores: ["dist/", "node_modules/", "test/dogfood/", "src/*.md.spec.ts"],
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      sonarjs,
      local,
    },
    rules: {
      "local/experimental-name": "error",
      ...tseslint.configs["strict-type-checked"]?.rules,
      // TypeScript handles these better than ESLint
      "no-undef": "off",
      "no-unused-vars": "off",
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // We use createRequire legitimately for linter detection
      "@typescript-eslint/no-require-imports": "off",
      // Relax some strict rules that are too noisy for this codebase
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Ban non-null assertions — use proper narrowing instead
      "@typescript-eslint/no-non-null-assertion": "error",

      // --- Complexity rules ---
      complexity: ["warn", { max: 15 }],
      "max-depth": ["warn", { max: 4 }],
      "max-lines-per-function": [
        "warn",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      "max-params": ["warn", { max: 4 }],

      // --- SonarJS ---
      "sonarjs/cognitive-complexity": ["warn", 15],
      "sonarjs/no-duplicate-string": ["warn", { threshold: 4 }],
      "sonarjs/no-identical-functions": "warn",
      "sonarjs/no-duplicated-branches": "warn",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/nested-control-flow": ["warn", { maximumNestingLevel: 3 }],
    },
  },
  // Architectural boundary: core ⊄ adapter (eslint-plugin-boundaries).
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { boundaries },
    settings: {
      // NodeNext: imports use `.js` specifiers that resolve to `.ts` — the
      // typescript resolver maps them so boundaries can classify each dependency.
      "import/resolver": { typescript: { alwaysTryTypes: true } },
      "boundaries/elements": [
        { type: "cc-harness", mode: "full", pattern: CC_HARNESS },
        { type: "codex-harness", mode: "full", pattern: CODEX_HARNESS },
        { type: "opencode-harness", mode: "full", pattern: OPENCODE_HARNESS },
        { type: "verify-core", mode: "full", pattern: VERIFY_CORE },
        { type: "agnostic-surface", mode: "full", pattern: AGNOSTIC_SURFACE },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: { type: "verify-core" },
              disallow: {
                to: {
                  type: ["cc-harness", "codex-harness", "opencode-harness"],
                },
              },
              message:
                "Hexagonal boundary: the reference-verification domain (${file.type}) must not import a harness/transport adapter (${dependency.type}). Keep the core harness-agnostic — depend through a port, or move this module into the application layer. See research/code-adapter-architecture.md.",
            },
            {
              from: { type: "agnostic-surface" },
              disallow: {
                to: {
                  type: ["cc-harness", "codex-harness", "opencode-harness"],
                },
              },
              message:
                "Agnostic surface: the harness-agnostic public entry (${file.type}) must not import a specific harness adapter (${dependency.type}) — this includes src/mock-model.ts (the Claude-Code mock). Re-export ONLY the agnostic names from the composition-root runner modules (src/{harness-test,run-hook,eval}.ts); import harness-specific transport (scriptModel, claudeCodeDriver, loadPlugin) from vigiles/claude-code. See research/adapter-api-design.md.",
            },
          ],
        },
      ],
    },
  },
  // String-literal boundary: no hard-coded Claude Code literals in the
  // harness-agnostic domain/detectors. Catches the scan.ts/test-coverage.ts bug
  // class at lint time so a new harness's surfaces/token are never silently
  // ignored. Both forms — a plain string literal and a template-string quasi.
  {
    files: HARNESS_AGNOSTIC_DETECTORS,
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${CC_LITERAL_RE}/]`,
          message: CC_LITERAL_MSG,
        },
        {
          selector: `TemplateElement[value.raw=/${CC_LITERAL_RE}/]`,
          message: CC_LITERAL_MSG,
        },
      ],
    },
  },
  // No barrel imports: internal modules must import the LEAF that defines a
  // symbol, never the package's own public barrel entry points (the
  // `vigiles/<x>` surfaces — src/{linting,test,eval-surface,hook,
  // claude-code,codex,adapter}.ts). Importing a barrel pulls its whole
  // re-export graph (slow in the test runner / any non-treeshaking consumer,
  // and a circular-import risk), and re-leaks the internal seams the curated
  // barrels deliberately drop. The canonical eslint-plugin-barrel-files is
  // unusable here — its `avoid-importing-barrel-files` calls the
  // ESLint-9-removed `context.getFilename()` and crashes on ESLint 10 — so we
  // express the same intent with the built-in rule (prefer-existing-solutions:
  // a working core rule over a broken dependency). The barrels themselves are
  // exempt below, and tests may exercise the public surface. (They used to be
  // exempt because they composed each other up the e2e→integration→unit tier
  // ladder; that ladder is gone — the two cost-split barrels are siblings and
  // neither imports the other.)
  //
  // `**/<name>.js` matches the relative specifier at every depth
  // (`./x.js`, `../x.js`, `../../x.js`). The public `vigiles/adapter` barrel
  // (src/adapter.ts) is intentionally NOT listed: its basename collides with two
  // legitimate leaves — the `HarnessDialect`/`HarnessAdapter` port interface in
  // src/core/adapter.ts and each harness's src/adapters/<h>/adapter.ts — so a
  // basename glob can't target it without false-positiving the leaves. It's the
  // smallest barrel and nothing internal imports it, so the omission is safe.
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/*.test.ts",
      "src/{linting,test,eval-surface,hook,claude-code,codex,adapter}.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/linting.js",
                "**/test.js",
                "**/eval-surface.js",
                "**/hook.js",
                "**/claude-code.js",
                "**/codex.js",
              ],
              message:
                "No barrel imports: import the leaf module that defines this symbol (e.g. ./core/spec.js, ./run-hook.js), not the public barrel entry point (vigiles/<x>). Barrels pull their whole re-export graph and re-leak internal seams. The barrels themselves and tests are exempt.",
            },
          ],
        },
      ],
    },
  },
  // Discovery boundary (#192): every walk that polices the USER'S repo must
  // consume the parsed `.vigilesrc.json#exclude` (src/exclude.ts), never a
  // private ignore list. `findSpecs` hard-coded its own for a year while the
  // config's `exclude` never reached it, and the two walks that DID honour it
  // used two dialects that disagreed on a bare directory name. Three shapes are
  // refused in the files that hold these walks:
  //   S1  `globSync(p, {...})` with no `ignore` at all;
  //   S2  an `ignore` array holding a string LITERAL (`[...X, "dist/**"]` — the
  //       original bug shape; `[...ignore]`, a spread of an injected list, is fine);
  //   S3  (cli-main.ts only) a raw `readdirSync` — the walks that legitimately keep
  //       one (init's shallow sweep, lint-config collection, eject's safety
  //       check, the nested-bundle walk that already consumes the ExcludeSet)
  //       carry an eslint-disable with the exception row from exclude.ts.
  // Flat config REPLACES a rule's options rather than merging, so the files that
  // are also harness-agnostic detectors restate the CC-literal selectors here.
  {
    files: [
      "src/core/doc-refs.ts",
      "src/core/orphans.ts",
      "src/core/coverage.ts",
      "src/test-coverage.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${CC_LITERAL_RE}/]`,
          message: CC_LITERAL_MSG,
        },
        {
          selector: `TemplateElement[value.raw=/${CC_LITERAL_RE}/]`,
          message: CC_LITERAL_MSG,
        },
        ...DISCOVERY_SELECTORS,
      ],
    },
  },
  {
    files: ["src/cli-main.ts", "src/adapters/claude-code/run-scripts.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...DISCOVERY_SELECTORS],
    },
  },
  {
    files: ["src/cli-main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...DISCOVERY_SELECTORS,
        {
          selector: 'CallExpression[callee.name="readdirSync"]',
          message:
            "A raw readdirSync walk in cli-main.ts bypasses the ExcludeSet (src/exclude.ts). " +
            "Route discovery through it, or — if this walk is one of the named exceptions " +
            "in exclude.ts's header — add an eslint-disable naming that exception.",
        },
      ],
    },
  },
  // Test files: relax promise, assertion, and complexity rules
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // node:test describe/it return promises that don't need to be awaited
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Tests are naturally longer and more repetitive
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
    },
  },
];
