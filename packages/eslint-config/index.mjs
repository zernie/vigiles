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

const sizeRule = (rule, n) =>
  rule === "max-lines-per-function"
    ? ["error", { ...MAX_LINES, max: n }]
    : ["error", n];

/** The strict rules for TypeScript source. Needs the @typescript-eslint plugin registered. */
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

/** A test's `describe` callback is a list of cases, not a function to split. */
export const testSizes = (files) => ({
  files,
  rules: { "max-lines-per-function": sizeRule("max-lines-per-function", 60) },
});

/**
 * Per-file ceilings for functions written before the limits: each number is the
 * file's measured maximum, so its functions may shrink and may not grow. Lower a
 * number after a refactor; a file leaves the table once it is under the limits.
 *
 * @param table {Record<string, Partial<Record<keyof typeof SIZE_LIMITS, number>>>}
 */
export const ceilings = (table) =>
  Object.entries(table).map(([file, max]) => ({
    files: [file],
    rules: Object.fromEntries(
      Object.entries(max).map(([rule, n]) => [rule, sizeRule(rule, n)]),
    ),
  }));

/** No `let`, no mutation, no loops, readonly parameters. Tests may mutate their fixtures. */
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
const libraries = (source) => ({ to: { module: { origin: ORIGINS, source } } });
const elements = (...types) => ({ element: { types: { anyOf: types } } });
const APP = { file: { categories: "app" } };
const ROOT = { file: { categories: "root" } };

/** Who may import whom: the domain knows only itself, an adapter never another adapter. */
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

const element = (type, pattern, extra = {}) =>
  pattern === undefined
    ? []
    : [{ type, pattern, partialMatch: false, ...extra }];

/**
 * The hexagonal layers, as one eslint-plugin-boundaries block. Every linted file
 * must be a declared element or category, so a new file cannot sit outside the
 * rules.
 *
 * `root` must be the repository directory. Without `boundaries/root-path` the
 * plugin matches patterns against `process.cwd()`, and lint started from any
 * other directory classifies nothing and passes.
 *
 * @param o.domain  folder of the domain, e.g. "src/core"
 * @param o.ports   folder of the ports, if the repo has one
 * @param o.adapters  adapter folders, one element each, e.g. "src/adapters/*"
 * @param o.cliRoot the composition root: the only non-test file that may wire anything to anything
 * @param o.app     the flat application files, e.g. "src/*.ts"
 * @param o.tests   test files
 * @param o.io      files allowed to do I/O, e.g. "src/adapters/*\/*.io.ts"
 */
export const layers = (o) => ({
  files: o.files,
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

/** `process` and `fetch` are not imports, so `layers` cannot see them. Same scope as its effects rule. */
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
