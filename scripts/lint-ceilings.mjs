// @ts-check
/**
 * Per-file ceilings for functions written before the size limits in
 * packages/eslint-config (complexity, depth, length, parameters, nesting).
 *
 * A suppression would not work for these rules: they report one finding per
 * function however far over the limit it is, so a suppressed function could keep
 * growing. Instead each old file gets its measured maximum as its own limit, in
 * eslint-ceilings.json, which ESLint then enforces.
 *
 *   node scripts/lint-ceilings.mjs           exit 1 if any ceiling can come down
 *   node scripts/lint-ceilings.mjs --write   lower ceilings to what is measured now
 *   node scripts/lint-ceilings.mjs --init    record every file over a limit
 *
 * Nothing here raises a ceiling. A function that grows past its file's ceiling
 * is an ESLint error, and `--init` is for the first run only.
 *
 * `.mjs`, not `.ts`: CI runs Node 20, which cannot run TypeScript.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tsparser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

import { SIZE_LIMITS } from "../packages/eslint-config/index.mjs";

const TABLE = "eslint-ceilings.json";
const FILES = ["src/**/*.ts"];
const TEST = /\.test\.ts$/;

/** @typedef {keyof typeof SIZE_LIMITS} SizeRule */
/** @typedef {Record<string, Partial<Record<SizeRule, number>>>} Table */

/** The measured value in each rule's report data. */
const MEASURED_BY = {
  complexity: "complexity",
  "sonarjs/cognitive-complexity": "complexityAmount",
  "max-depth": "depth",
  "max-params": "count",
  "max-lines-per-function": "lineCount",
  "max-nested-callbacks": "num",
};

/**
 * The limit a file is held to without a ceiling. Tests get sixty lines a
 * function (see testSizes in packages/eslint-config).
 *
 * @param {string} file
 * @param {SizeRule} rule
 */
export const limitFor = (file, rule) =>
  rule === "max-lines-per-function" && TEST.test(file) ? 60 : SIZE_LIMITS[rule];

/**
 * The next table: each entry lowered to what is measured now, entries under the
 * limit dropped, nothing raised. With `init`, every file over a limit is added.
 *
 * @param {Table} current
 * @param {Table} measured  the maximum per file and rule
 * @param {{ init: boolean }} options
 * @returns {Table}
 */
export const nextCeilings = (current, measured, { init }) => {
  const files = init ? Object.keys(measured) : Object.keys(current);
  const entries = files.map((file) => {
    const rules = /** @type {SizeRule[]} */ (
      Object.keys(init ? (measured[file] ?? {}) : (current[file] ?? {}))
    );
    const kept = rules.flatMap((rule) => {
      const now = measured[file]?.[rule] ?? 0;
      const ceiling = Math.min(current[file]?.[rule] ?? now, now);
      return ceiling > limitFor(file, rule) ? [[rule, ceiling]] : [];
    });
    return /** @type {const} */ ([file, Object.fromEntries(kept)]);
  });
  return Object.fromEntries(
    entries
      .filter(([, rules]) => Object.keys(rules).length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};

/** @typedef {{ type: string, value: string, line: number }} Directive */

/**
 * Whether an eslint-disable comment exempts `line` from `rule`. An exempted
 * function is a deliberate exception, not debt, so it gets no ceiling.
 *
 * @param {readonly Directive[]} directives  in source order
 * @param {string} rule
 * @param {number} line
 */
export const exempted = (directives, rule, line) => {
  const covers = (/** @type {Directive} */ d) =>
    d.value === "" || d.value.split(",").some((name) => name.trim() === rule);
  const relevant = directives.filter(covers);
  const onLine = relevant.some(
    (d) =>
      (d.type === "disable-line" && d.line === line) ||
      (d.type === "disable-next-line" && d.line + 1 === line),
  );
  const lastBlock = relevant
    .filter(
      (d) => (d.type === "disable" || d.type === "enable") && d.line <= line,
    )
    .at(-1);
  return onLine || lastBlock?.type === "disable";
};

/**
 * Wraps a rule so that, run with a limit of zero, it reports every function's
 * size to `record` instead of to ESLint, except where a disable comment exempts it.
 *
 * @param {import("eslint").Rule.RuleModule} rule
 * @param {string} name  the rule's real name, as disable comments spell it
 * @param {string} key
 * @param {(file: string, value: number) => void} record
 * @returns {import("eslint").Rule.RuleModule}
 */
const measuring = (rule, name, key, record) => ({
  ...rule,
  // ESLint freezes the context, so `report` is replaced on an object that
  // inherits from it rather than through a Proxy.
  create: (context) =>
    rule.create(
      Object.create(context, {
        report: {
          value: (
            /** @type {{ data?: Record<string, unknown>, loc?: { start: { line: number } }, node?: { loc: { start: { line: number } } } }} */ d,
          ) => {
            const line = d.loc?.start.line ?? d.node?.loc.start.line ?? 0;
            const directives = context.sourceCode
              .getDisableDirectives()
              .directives.map((x) => ({
                type: x.type,
                value: x.value,
                line: x.node.loc?.start.line ?? 0,
              }));
            if (!exempted(directives, name, line))
              record(context.filename, Number(d.data?.[key]));
          },
        },
      }),
    ),
});

/** Zero, so every function is reported; line counts skip what the lint limit skips. */
const zero = (/** @type {string} */ rule) =>
  rule === "max-lines-per-function"
    ? ["error", { max: 0, skipComments: true, skipBlankLines: true }]
    : ["error", 0];

/** @returns {Promise<Table>} the largest value per file and rule, over every function */
const measure = async () => {
  /** @type {Table} */
  const max = {};
  const sources = {
    ...Object.fromEntries(builtinRules),
    "sonarjs/cognitive-complexity": sonarjs.rules["cognitive-complexity"],
  };
  const rules = Object.fromEntries(
    Object.entries(MEASURED_BY).map(([rule, key]) => [
      rule.replace("sonarjs/", ""),
      measuring(sources[rule], rule, key, (file, value) => {
        const at = file.slice(process.cwd().length + 1);
        const seen = (max[at] ??= {});
        seen[/** @type {SizeRule} */ (rule)] = Math.max(seen[rule] ?? 0, value);
      }),
    ]),
  );
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: FILES,
      languageOptions: { parser: tsparser },
      plugins: { measure: { rules } },
      rules: Object.fromEntries(
        Object.keys(rules).map((name) => [`measure/${name}`, zero(name)]),
      ),
    },
  });
  await eslint.lintFiles(FILES);
  return max;
};

const main = async () => {
  const mode = process.argv[2] ?? "--check";
  const current = /** @type {Table} */ (
    JSON.parse(readFileSync(TABLE, "utf8"))
  );
  const next = nextCeilings(current, await measure(), {
    init: mode === "--init",
  });
  if (mode === "--write" || mode === "--init") {
    writeFileSync(TABLE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`${TABLE}: ${String(Object.keys(next).length)} files`);
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  console.error(
    `${TABLE} can come down (a function got smaller, or a file is under the limits now).\n` +
      `Run: node scripts/lint-ceilings.mjs --write`,
  );
  process.exitCode = 1;
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
