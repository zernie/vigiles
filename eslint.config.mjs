import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";

import { readdirSync } from "node:fs";

import experimentalName from "./eslint-rules/experimental-name.mjs";
import frameMint from "./eslint-rules/frame-mint.mjs";
import noHarnessNames from "./eslint-rules/no-harness-names.mjs";

/**
 * The harness names `local/no-harness-names` forbids, READ FROM THE ADAPTER
 * DIRECTORY rather than written out here.
 *
 * 🔴 THE LIST USED TO LIVE IN THE RULE, as `DEFAULT_NAMES = ["claude-code",
 * "codex", "opencode"]`, and a hand-written list of what exists is exactly the
 * defect the port redesign is removing everywhere else: a new adapter would have
 * left the rule silent for its name until somebody remembered this file. Reading
 * the directory makes registering an adapter turn the rule on for it.
 *
 * ⚠️ THE ASSUMPTION IS THAT A DIRECTORY IS NAMED AFTER ITS ADAPTER, and it is
 * checked — but by `adapter-contract.test.ts` ("every implementation's directory
 * is named after it"), which runs under vitest and not under eslint. So a
 * mis-named directory leaves the rule silent for that name until the test runs.
 * Named rather than hidden; the alternative (importing the registry into the
 * eslint config) would make linting depend on a TypeScript build.
 */
const HARNESS_NAMES = readdirSync("src/adapters", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// The repo's own rules. Two members — see each rule's header for why it is a rule
// and not something else. `experimental-name` replaced a standalone script that
// hand-rolled a parser over declaration lines; `no-harness-names` closes the gap
// the three existing harness fences leave open (they match `.claude`, adapter
// IMPORTS and the port contract — none of them matches the string "claude-code",
// and none of them looks at a TYPE).
const local = {
  rules: {
    "experimental-name": experimentalName,
    "frame-mint": frameMint,
    "no-harness-names": noHarnessNames,
  },
};

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
  // Added 2026-09-22 with the #263 names half. This module is named for the
  // harness-AGNOSTIC read-vs-run decision and held `hasModelAccess`, whose whole
  // body was `ANTHROPIC_API_KEY` / `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`. Now
  // that the predicate lives in the Claude Code adapter and every harness
  // answers through `HarnessLiveDriver.access`, this file holds zero `ANTHROPIC_`
  // tokens — and the fence is what stops it being re-declared here.
  "src/scan-trigger-suggest.ts",
];
/**
 * Where a harness NAME literal (`"claude-code"`, `"codex"`, `"opencode"`) is an
 * error — a SUPERSET of the detectors above, and deliberately a separate list.
 *
 * 🔴 IT CANNOT BE THE SAME LIST. `HARNESS_AGNOSTIC_DETECTORS` also drives the
 * CC_LITERAL fence (`.claude`, `ANTHROPIC_`, `CLAUDE_PLUGIN_ROOT`), which
 * `src/scan-behavioral.ts` would trip on its Claude Code import paths while
 * being perfectly entitled to them — it is the application layer that drives a
 * real harness binary. Two fences, two sets.
 *
 * Added 2026-09-22 with the #263 names half, which emptied this file of
 * name-driven behaviour: `scan-behavioral.ts` went from nine harness literals to
 * three, and all three are now IMPORT PATHS rather than decisions. The rule is
 * what stops a fourth coming back as a decision.
 *
 * ⚠️ `src/cli-main.ts` IS DELIBERATELY NOT HERE, AND THAT IS A MEASUREMENT, NOT
 * AN OVERSIGHT. The design for this stage listed it with "5 disables, under the
 * rule's own precedent of eleven". Measured on the finished tree it is
 * EIGHTEEN, seventeen of them against sanctioned code: four Claude Code import
 * paths (248, 258, 278, 290) and thirteen `init` onboarding sites, including
 * user-facing prose like `"Codex / GitHub Copilot"` (3809, 4476). That is
 * exactly the shape this rule's own header rejects — "a rule that opens with
 * findings against sanctioned code is switched off the same day, not fixed" —
 * so the property is held over `cli-main.ts` by the narrower fence below, which
 * measures TWO findings instead of eighteen.
 */
const HARNESS_NAME_FENCE = [
  ...HARNESS_AGNOSTIC_DETECTORS,
  "src/scan-behavioral.ts",
];

/**
 * The same invariant over `src/cli-main.ts`, narrowed from "may not SPELL a
 * harness" to "may not DECIDE by one" — because in the composition root the
 * first is false (its `init` path installs vigiles's plugin into a named
 * harness and prints that harness's name to a human) and the second is the
 * thing #263 removed.
 *
 * 🔴 THE NAMES ARE IN THE PATTERN, and that is what makes this usable at
 * `error`. The redesign measured a name-FREE version of this selector
 * (`.name === <any Literal>`) and rejected it: of its findings, two were
 * `harness === ""` — false positives at error level. A literal that must BE a
 * harness name cannot match `""`. It also drops the
 * `MemberExpression[property.name="name"]` receiver, closing the other hole the
 * redesign named (§8.4): a comparison made through a differently-named variable.
 *
 * Measured over all of `src/**` non-test on the finished tree: TWO findings,
 * both in `cli-main.ts`, each disabled at its line with its reason.
 */
const HARNESS_DECISION_SELECTOR = {
  selector: `BinaryExpression[operator=/^[!=]==$/] > Literal[value=/^(${HARNESS_NAMES.join("|")})$/]`,
  message:
    "Do not DECIDE by harness name in the CLI. Read the fact off the adapter — " +
    "a port method, a capability field, or a tagged union on one of its " +
    "drivers. If this really is the composition root's own UI (init " +
    "onboarding) or a measurement status with no port behind it yet, disable " +
    "this line and say which, in a comment.",
};
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
      "Pass the ExcludeSet from src/exclude.ts (`ignore: excludes.globIgnore`, correct " +
      "from any cwd; `withIgnored(floor, excludes.globIgnore)` from src/core/glob-ignore.ts " +
      "when the walk also has its own floor).",
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
      // 🔴 THE PAYOFF HALF OF "Make The Distinction A Type". A tagged union forces every
      // EXISTING call site once (the old comparisons stop compiling); it does nothing for the
      // member added NEXT year unless a switch is checked for exhaustiveness. This rule is
      // that guarantee. `considerDefaultExhaustiveForUnions` because a `default:` that
      // handles the rest IS exhaustive — without it the rule fires on `switch (kind: string |
      // undefined)` in handleHookRuntime, which has a proper default and nothing to enumerate:
      // measured 2026-09-20, exactly one finding on the whole corpus and it was that one.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Ban non-null assertions — use proper narrowing instead
      "@typescript-eslint/no-non-null-assertion": "error",

      // --- Mutation: the caller's object is not yours to edit ---
      //
      // WARN, not error, and the severity is the MEASUREMENT (2026-09-15, on
      // `src/**/*.ts` minus tests): 18 findings — 13 real, 4 in the verbatim
      // Node `path.js` port (disabled in-file, where the same exemption already
      // stands for the complexity rules), 1 a `reduce` accumulator whose literal
      // is created on the spot (`ignorePropertyModificationsFor` below). A real
      // list of work, so it is on; not yet zero, so it does not gate.
      //
      // WHY THIS RULE AND NOT A PLUGIN. `eslint-plugin-functional` was measured
      // on the same corpus the same day and REJECTED on the numbers, not on
      // taste: `immutable-data` + `no-let` + `no-loop-statements` = 2309
      // findings across 149 of 210 files; narrowing to `prefer-immutable-types`
      // (parameters only) = 685; `type-declaration-immutability` = 413. A rule
      // that opens with four figures is silenced the day it lands, which costs
      // more than it catches. This one is ESLint core — no dependency, no
      // install — and it targets the half that actually bites: mutating a
      // parameter's properties is visible to the CALLER, while a local
      // accumulator is nobody's business but the function's.
      //
      // LODASH IS NOT THE ALTERNATIVE EITHER: it is not an immutability
      // library — `_.merge` mutates its first argument, which is this very bug
      // with a nicer name — and the CLI is deliberately runtime-dep-light. A
      // deep-update helper is worth reaching for only once a shape genuinely
      // needs one, and none does today.
      //
      // THE PRIMARY DEFENCE IS THE TYPE, NOT THIS RULE. `readonly` on the
      // container makes `push` a tsc error, which is the irrepresentable-state
      // move `ts-essentials` asks for; this rule is the backstop for the shapes
      // that have not been typed that way yet. See the `prefer-immutable-updates`
      // rule in CLAUDE.md for the reasoning it backs.
      "no-param-reassign": [
        "warn",
        { props: true, ignorePropertyModificationsFor: ["acc"] },
      ],

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
  // A path-frame brand is minted in src/core/frame.ts and nowhere else (#281).
  // `RepoPath` makes a bundle-relative or absolute path fail to compile where a
  // repo-relative one is wanted; an `as RepoPath` would make it compile again with
  // the wrong frame inside. A rule id of its own rather than one more
  // `no-restricted-syntax` selector: flat config REPLACES that rule's options per
  // file group, so a selector added here would silently drop the others.
  // Measured 2026-09-23: zero findings on the tree as it stands.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/core/frame.ts"],
    plugins: { local },
    rules: {
      "local/frame-mint": ["error", { types: ["RepoPath", "BundlePath"] }],
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
  // Harness-NAME boundary (`local/no-harness-names`), the sibling of the block
  // above and deliberately a separate rule id rather than two more selectors in
  // it. Three reasons, all mechanical: (1) the sites that need an exemption take
  // a targeted `eslint-disable-next-line local/no-harness-names` instead of
  // switching off the CC-literal and globSync guards on the same line; (2) flat
  // config REPLACES a rule's options rather than merging, so the four files below
  // that also carry discovery selectors would have had to restate every harness
  // selector too — the drift seam this file already works around twice; (3) the
  // identifier half (`claudeCodeLayout` → segments → `claudecode`) is not
  // expressible as a selector regex, which sees an identifier as one flat string.
  //
  // WHAT IT CATCHES THAT THE BLOCK ABOVE DOES NOT: `CC_LITERAL_RE` is
  // `CLAUDE_PLUGIN_ROOT|\.claude|ANTHROPIC_`. `.claude` needs the dot, so the
  // canonical adapter NAME "claude-code" walks past it, and "codex"/"opencode"
  // were never in it. Measured on this tree with all three existing fences green:
  // eight such nodes in `src/core/**` (non-test), five of them traceable to ONE
  // type alias — `SkillFrontmatterProfile = "claude-code" | "minimal"` — whose
  // name then propagates into every signature that mentions it.
  {
    files: HARNESS_NAME_FENCE,
    ignores: ["src/**/*.test.ts"],
    plugins: { local },
    rules: {
      "local/no-harness-names": ["error", { names: HARNESS_NAMES }],
    },
  },
  // The same invariant over `src/cli-main.ts`, narrowed from "may not SPELL a
  // harness" to "may not DECIDE by one" — because in the composition root the
  // first is false (its `init` path installs vigiles's plugin into a named
  // harness and prints that harness's name to a human) and the second is the
  // thing #263 removed.
  //
  // 🔴 THE NAMES ARE IN THE PATTERN, and that is what makes this usable at
  // `error`. The redesign measured a name-FREE version of this selector
  // (`.name === <any Literal>`) and rejected it: 46 findings over the detectors,
  // of which two were `harness === ""` — false positives at error level. A
  // literal that must BE a harness name cannot match `""`. It also drops the
  // `MemberExpression[property.name="name"]` receiver, closing the other hole
  // the redesign named: a comparison through a differently-named variable.
  //
  // Measured over all of `src/**` non-test on the finished tree: TWO findings,
  // both in this file, both disabled below with their reason — `shortHarness`
  // (the canonical→short mapping `init` keys on) and the one application-layer
  // name-check §2/§6 of the design keeps on purpose.

  // The identifier half, CORE ONLY — because that is where it turns on silent.
  // Measured, non-test: `src/core/**` has 0 identifier hits, while `src/scan.ts`
  // (6) and `src/test-coverage.ts` (2) hold `claudeCodeLayout`/`claudeCodeDialect`.
  // Three of those eight are the import specifiers, which the STRING half already
  // catches via the `/claude-code/` module path (and which carry a disable naming
  // the debt). The other five are USES, where the adapter is the DEFAULT value of
  // a layout/dialect parameter — the stated backwards-compatibility guarantee
  // ("Claude Code stays the default everywhere"). Turning identifiers on for these
  // two files would open with findings against sanctioned code, which is how a
  // rule gets switched off rather than fixed.
  // ⚠️ So it is a DECLARED hole: there the rule sees the import and not the five
  // uses downstream of it. Closing it is port injection in the code, not an edit
  // here.
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { local },
    rules: {
      "local/no-harness-names": [
        "error",
        { names: HARNESS_NAMES, identifiers: true },
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
        // #263: the CLI reads harness facts off the adapter, never off its name.
        HARNESS_DECISION_SELECTOR,
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
