import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

import { readdirSync, readFileSync } from "node:fs";

import experimentalName from "./eslint-rules/experimental-name.mjs";
import frameMint from "./eslint-rules/frame-mint.mjs";
import noHarnessNames from "./eslint-rules/no-harness-names.mjs";
import {
  AS_UNKNOWN_AS,
  ONE_COLLECTION_LIBRARY,
  PURE_LIBRARIES,
  ceilings,
  functionalCode,
  ioGlobals,
  layers,
  strictTypeScript,
  testSizes,
} from "./packages/eslint-config/index.mjs";

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

// The repo's own rules; each one's header says why it is a rule. `no-harness-names`
// is the harness fence: no file may spell a harness that is not its own, by name,
// directory or environment variable, in a value, a type or an identifier.
const local = {
  rules: {
    "experimental-name": experimentalName,
    "frame-mint": frameMint,
    "no-harness-names": noHarnessNames,
  },
};

/**
 * Strings that spell a harness besides its name: its config directory and its
 * environment variables. Only Claude Code's are listed so far; a harness's own go
 * here when its adapter starts using them.
 */
const HARNESS_LITERALS = {
  "claude-code": ["CLAUDE_PLUGIN_ROOT", ".claude", "ANTHROPIC_"],
};

/** The composition root: the one non-test place that wires a real adapter in. */
const CLI_ROOT = "src/cli{,-main}.ts";

const without = (record, key) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

/**
 * Each adapter may spell its own harness and no other; everything else outside
 * the root may spell none. Tests included: a test of generic code that names
 * Claude Code is testing Claude Code.
 */
const harnessFences = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/adapters/**", CLI_ROOT],
    plugins: { local },
    rules: {
      "local/no-harness-names": [
        "error",
        { names: HARNESS_NAMES, identifiers: true, literals: HARNESS_LITERALS },
      ],
    },
  },
  ...HARNESS_NAMES.map((own) => ({
    files: [`src/adapters/${own}/**/*.ts`],
    plugins: { local },
    rules: {
      "local/no-harness-names": [
        "error",
        {
          names: HARNESS_NAMES.filter((name) => name !== own),
          identifiers: true,
          literals: without(HARNESS_LITERALS, own),
        },
      ],
    },
  })),
];

/** Per-file ceilings for functions older than the size limits. Generated, then only lowered. */
const CEILINGS = JSON.parse(readFileSync("eslint-ceilings.json", "utf8"));

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
      // Ban non-null assertions — use proper narrowing instead
      "@typescript-eslint/no-non-null-assertion": "error",

      // Reassigning a parameter, or one of its properties, is invisible at the call
      // site. The functional rules cover the rest of mutation.
      "no-param-reassign": [
        "error",
        { props: true, ignorePropertyModificationsFor: ["acc"] },
      ],

      // --- SonarJS ---
      "sonarjs/no-duplicate-string": ["error", { threshold: 4 }],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-nested-conditional": "error",
      "sonarjs/nested-control-flow": ["error", { maximumNestingLevel: 3 }],
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
  // One collection library and no `as unknown as`, everywhere including tests. The
  // blocks below that set the same two rules for their own files restate these,
  // because flat config replaces a rule's options instead of merging them.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: ONE_COLLECTION_LIBRARY }],
      "no-restricted-syntax": ["error", AS_UNKNOWN_AS],
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
          paths: ONE_COLLECTION_LIBRARY,
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
  {
    files: [
      "src/core/doc-refs.ts",
      "src/core/orphans.ts",
      "src/core/coverage.ts",
      "src/test-coverage.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", AS_UNKNOWN_AS, ...DISCOVERY_SELECTORS],
    },
  },
  {
    files: ["src/cli-main.ts", "src/adapters/claude-code/run-scripts.ts"],
    rules: {
      "no-restricted-syntax": ["error", AS_UNKNOWN_AS, ...DISCOVERY_SELECTORS],
    },
  },
  {
    files: ["src/cli-main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        AS_UNKNOWN_AS,
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
  // The strict rules shared with paperlint (packages/eslint-config). Old code is
  // grandfathered: counting rules in eslint-suppressions.json, function sizes in
  // eslint-ceilings.json. Both may only shrink.
  strictTypeScript(["src/**/*.ts"]),
  functionalCode({ files: ["src/**/*.ts"], ignores: ["src/**/*.test.ts"] }),
  layers({
    files: ["src/**/*.ts"],
    root: import.meta.dirname,
    domain: "src/core",
    adapters: "src/adapters/*",
    cliRoot: CLI_ROOT,
    app: "src/*.ts",
    tests: "src/**/*.test.ts",
    io: "src/adapters/*/*.io.ts",
    // Parsers the domain legitimately runs. None of them does I/O.
    domainLibraries: [
      ...PURE_LIBRARIES,
      "typescript",
      "js-yaml",
      "zod",
      "@ast-grep/napi",
      "zlib",
      "node:zlib",
    ],
  }),
  ioGlobals({
    files: ["src/**/*.ts"],
    ignores: [CLI_ROOT, "src/adapters/*/*.io.ts", "src/**/*.test.ts"],
  }),
  ...harnessFences,
  // Test files: relax promise and duplication rules
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // node:test describe/it return promises that don't need to be awaited
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Tests repeat their fixtures on purpose
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
    },
  },
  testSizes(["src/**/*.test.ts"]),
  // Last, so a ceiling overrides the limit it raises.
  ...ceilings(CEILINGS),
];
