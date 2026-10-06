// @ts-check
/**
 * The strict lint rules vigiles and paperlint share.
 *
 * `.mjs`, not `.ts`: ESLint loads a config without a build step, and paperlint
 * imports this file by path from `node_modules/vigiles/packages/eslint-config/`.
 * That import is deliberate and private: vigiles' `exports` has no entry for this
 * file, so nobody else should depend on it.
 *
 * The plugins are not bundled. Each repo installs eslint-plugin-boundaries,
 * eslint-plugin-functional and eslint-plugin-sonarjs itself, and the imports
 * below resolve to that copy.
 *
 * What each repo keeps for itself: its folder layout (passed to `layers`), its
 * ceiling table for old functions (passed to `ceilings`) and its
 * eslint-suppressions.json.
 */
import boundaries from "eslint-plugin-boundaries";
import functional from "eslint-plugin-functional";
import sonarjs from "eslint-plugin-sonarjs";

/** @typedef {import("eslint").Linter.Config} Config */
/** @typedef {import("eslint").Linter.RuleEntry} RuleEntry */
/** @typedef {{ files: string[], ignores?: string[] }} Scope */

/** One collection library: remeda. These would be a second one for the same job. */
export const ONE_COLLECTION_LIBRARY = ["lodash", "lodash-es", "ramda"].map(
  (name) => ({ name, message: "Use remeda." }),
);

/** `x as unknown as T` switches the type checker off. For `no-restricted-syntax`. */
export const AS_UNKNOWN_AS = {
  selector:
    "TSAsExpression > TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
  message:
    "`as unknown as` switches the type checker off. Convert with a function, or fix the type.",
};

/** A function is one job; at thirty lines a second one starts to hide. */
const MAX_LINES = { max: 30, skipComments: true, skipBlankLines: true };

/**
 * Limits on the size of a function. These rules report one finding per function
 * however far over the limit it is, so a suppressed finding would let the
 * function keep growing. Old functions get a ceiling instead (see `ceilings`).
 */
export const SIZE_LIMITS = {
  complexity: 10,
  "sonarjs/cognitive-complexity": 10,
  "max-depth": 3,
  "max-params": 4,
  "max-lines-per-function": MAX_LINES.max,
  "max-nested-callbacks": 3,
};

/** @typedef {keyof typeof SIZE_LIMITS} SizeRule */

/**
 * @param {string} rule
 * @param {number} n
 * @returns {RuleEntry}
 */
const sizeRule = (rule, n) =>
  rule === "max-lines-per-function"
    ? ["error", { ...MAX_LINES, max: n }]
    : ["error", n];

/**
 * The strict rules for TypeScript source. Needs the @typescript-eslint plugin registered.
 *
 * @param {string[]} files
 * @returns {Config}
 */
export const strictTypeScript = (files) => ({
  files,
  plugins: { sonarjs },
  rules: {
    ...Object.fromEntries(
      Object.entries(SIZE_LIMITS).map(([rule, n]) => [rule, sizeRule(rule, n)]),
    ),
    "@typescript-eslint/no-explicit-any": "error",
    // `x as T` is a claim the checker takes on trust. Parse or narrow instead.
    "@typescript-eslint/consistent-type-assertions": [
      "error",
      { assertionStyle: "never" },
    ],
    "@typescript-eslint/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],
    // Not set here: `no-restricted-imports` and `no-restricted-syntax`. Flat config
    // replaces a rule's options per file group, so a repo that sets either for its
    // own reasons would silently drop ours. Merge ONE_COLLECTION_LIBRARY and
    // AS_UNKNOWN_AS into the repo's own blocks instead.
  },
});

/**
 * A test's `describe` callback is a list of cases, not a function to split.
 *
 * @param {string[]} files
 * @returns {Config}
 */
export const testSizes = (files) => ({
  files,
  rules: { "max-lines-per-function": sizeRule("max-lines-per-function", 60) },
});

/**
 * Per-file ceilings for functions written before the limits: each number is the
 * file's measured maximum, so its functions may shrink and may not grow. Lower a
 * number after a refactor; a file leaves the table once it is under the limits.
 *
 * @param {Record<string, Partial<Record<SizeRule, number>>>} table
 * @returns {Config[]}
 */
export const ceilings = (table) =>
  Object.entries(table).map(([file, max]) => ({
    files: [file],
    rules: Object.fromEntries(
      Object.entries(max).map(([rule, n]) => [rule, sizeRule(rule, n)]),
    ),
  }));

/**
 * No `let`, no mutation, no loops, readonly parameters. Tests may mutate their fixtures.
 *
 * @param {Scope} scope
 * @returns {Config}
 */
export const functionalCode = ({ files, ignores }) => ({
  files,
  ignores,
  plugins: { functional },
  rules: {
    "functional/no-let": "error",
    "functional/immutable-data": "error",
    "functional/no-loop-statements": "error",
    "functional/prefer-immutable-types": [
      "error",
      { enforcement: "ReadonlyShallow", ignoreInferredTypes: true },
    ],
  },
});

/** Node modules that ARE effects. Only an `io` file, a test or the root may import one. */
export const IO_MODULES = [
  "fs",
  "fs/promises",
  "child_process",
  "os",
  "net",
  "http",
  "https",
  "worker_threads",
  "readline",
  "readline/promises",
].flatMap((m) => [m, `node:${m}`]);

/** Libraries the domain and ports may use: types, pure path arithmetic, hashing, collections. */
export const PURE_LIBRARIES = [
  "ts-essentials",
  "remeda",
  "path",
  "node:path",
  "crypto",
  "node:crypto",
];

/** What app files may use besides: Node's pure helpers. */
export const APP_LIBRARIES = [
  ...PURE_LIBRARIES,
  "util",
  "node:util",
  "url",
  "node:url",
  "module",
  "node:module",
];

const ORIGINS = ["external", "core"];
/** @param {string[]} source */
const libraries = (source) => ({ to: { module: { origin: ORIGINS, source } } });
/** @param {...string} types */
const elements = (...types) => ({ element: { types: { anyOf: types } } });
const APP = { file: { categories: "app" } };
const ROOT = { file: { categories: "root" } };

/** Who may import whom: the domain knows only itself, an adapter never another adapter. */
/**
 * @param {string[]} domainLibraries
 * @param {string[]} appLibraries
 */
const knowledgePolicies = (domainLibraries, appLibraries) => [
  { from: elements("domain"), allow: { to: elements("domain") } },
  { from: elements("port"), allow: { to: elements("domain", "port") } },
  { from: APP, allow: { to: [elements("domain", "port"), APP] } },
  { from: elements("adapter"), allow: { to: elements("domain", "port") } },
  { from: ROOT, allow: { to: [{ element: { type: "*" } }, APP, ROOT] } },
  { from: elements("domain", "port"), allow: libraries(domainLibraries) },
  { from: APP, allow: libraries(appLibraries) },
  {
    from: [elements("adapter"), ROOT],
    allow: { to: { module: { origin: ORIGINS } } },
  },
  {
    from: { file: { categories: "test" } },
    allow: {
      to: [
        { element: { type: "*" } },
        APP,
        ROOT,
        { module: { origin: ORIGINS } },
      ],
    },
  },
];

/**
 * Effects only in io files, tests and the root. Written as "nobody, then these
 * three": a file with no category has `categories: null`, and a `noneOf` query
 * never matches null, so the negative form would exempt every plain file.
 */
/** @param {string} ioPattern */
const effectPolicies = (ioPattern) => [
  {
    disallow: { to: { module: { origin: "core", source: IO_MODULES } } },
    message: `{{ dependency.source }} is I/O in a file that is not ${ioPattern}. Take a port instead, and do the I/O in an adapter's io file or the root.`,
  },
  {
    from: { file: { categories: ["io", "test", "root"] } },
    allow: { to: { module: { origin: "core", source: IO_MODULES } } },
  },
];

/**
 * @param {string} type
 * @param {string | undefined} pattern
 * @param {Record<string, unknown>} [extra]
 */
const element = (type, pattern, extra = {}) =>
  pattern === undefined
    ? []
    : [{ type, pattern, partialMatch: false, ...extra }];

/**
 * Where a repo keeps each layer. Patterns are relative to `root`.
 *
 * @typedef {object} Layout
 * @property {string[]} files       the files the rules apply to
 * @property {string} root          the repository directory
 * @property {string} domain        folder of the domain, e.g. "src/core"
 * @property {string} [ports]       folder of the ports, if the repo has one
 * @property {string} adapters      adapter folders, one element each, e.g. "src/adapters/*"
 * @property {string} cliRoot       the composition root: the only non-test file that may wire anything to anything
 * @property {string} app           the flat application files, e.g. "src/*.ts"
 * @property {string} tests         test files
 * @property {string} io            files allowed to do I/O, e.g. "src/adapters/*\/*.io.ts"
 * @property {string[]} [domainLibraries]  what the domain and ports may import (default PURE_LIBRARIES)
 * @property {string[]} [appLibraries]     what app files may import (default APP_LIBRARIES)
 * @property {object} [resolver]    import/resolver settings (default: the TypeScript resolver)
 * @property {object[]} [extraElements]  more boundaries elements, e.g. a folder of plain-JS modules
 * @property {object[]} [extraAllows]    more allow-policies, checked before the effects rule
 */

/**
 * The hexagonal layers, as one eslint-plugin-boundaries block. Every linted file
 * must be a declared element or category, so a new file cannot sit outside the
 * rules.
 *
 * `root` must be the repository directory. Without `boundaries/root-path` the
 * plugin matches patterns against `process.cwd()`, and lint started from any
 * other directory classifies nothing and passes.
 *
 * @param {Layout} o
 * @returns {Config}
 */
export const layers = (o) => ({
  files: o.files,
  // @ts-expect-error The plugin's types describe an ES module whose `default` is
  // the plugin; Node hands a default import of this CommonJS file the plugin
  // itself (keys meta, rules, configs). Runtime is right, the declaration is not.
  plugins: { boundaries },
  settings: {
    "boundaries/root-path": o.root,
    "import/resolver": o.resolver ?? { typescript: { alwaysTryTypes: true } },
    "boundaries/elements": [
      ...element("port", o.ports),
      ...element("domain", o.domain),
      ...element("adapter", o.adapters, { capture: ["name"] }),
      ...(o.extraElements ?? []),
    ],
    "boundaries/files": [
      { category: "root", pattern: o.cliRoot, exclusive: true },
      { category: "app", pattern: o.app },
      { category: "test", pattern: o.tests },
      { category: "io", pattern: o.io },
    ],
  },
  rules: {
    "boundaries/no-unknown-files": "error",
    "boundaries/no-unknown-dependencies": "error",
    "boundaries/dependencies": [
      "error",
      {
        default: "disallow",
        checkAllOrigins: true,
        policies: [
          ...knowledgePolicies(
            o.domainLibraries ?? PURE_LIBRARIES,
            o.appLibraries ?? APP_LIBRARIES,
          ),
          ...(o.extraAllows ?? []),
          ...effectPolicies(o.io),
        ],
      },
    ],
  },
});

/**
 * `process` and `fetch` are not imports, so `layers` cannot see them. Same scope as its effects rule.
 *
 * @param {Scope} scope
 * @returns {Config}
 */
export const ioGlobals = ({ files, ignores }) => ({
  files,
  ignores,
  rules: {
    "no-restricted-globals": [
      "error",
      {
        name: "process",
        message:
          "The environment is an input: the root reads it and passes a value in.",
      },
      {
        name: "fetch",
        message: "Network access belongs in an adapter's io file.",
      },
    ],
  },
});
