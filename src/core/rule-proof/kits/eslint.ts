/**
 * The ESLint kit: install through the repository's Node lockfile, one flat
 * config per reading, and `--format json` read back as per-file reports.
 */
import { join } from "node:path";
import { z } from "zod";
import type { ProofKit } from "../port.js";
import { jsonArray, toRelative, unreadable } from "../report.js";
import type { FileReport, LintParse, ReadingScope } from "../types.js";
import {
  nodeCacheEnv,
  nodeInstallPlan,
  packageManagerIn,
  versionIn,
} from "../node-install.js";

/** One ESLint configuration of one rule. */
export interface EslintReading {
  readonly linter: "eslint";
  /** The rule id as ESLint spells it: `no-console`, `react/jsx-key`. */
  readonly rule: string;
  /** The rule's options, after the severity. */
  readonly options: readonly unknown[];
  /** A parser package the repository has installed, e.g. for TypeScript files. */
  readonly parser?: string;
  readonly scope: ReadingScope;
}

/** The plugin package a rule id needs, by ESLint's naming convention. */
export function pluginOf(
  rule: string,
): { readonly prefix: string; readonly pkg: string } | null {
  const parts = rule.split("/");
  if (parts.length === 1) return null;
  const prefix = parts.slice(0, -1).join("/");
  if (!prefix.startsWith("@"))
    return { prefix, pkg: `eslint-plugin-${prefix}` };
  const [scope, name] = prefix.split("/");
  return {
    prefix,
    pkg:
      name === undefined
        ? `${scope}/eslint-plugin`
        : `${scope}/eslint-plugin-${name}`,
  };
}

const json = (value: unknown): string => JSON.stringify(value);

/**
 * The flat-config module for one reading. The scope's `ignores` stand in a
 * block of their own, which ESLint reads as GLOBAL ignores: a file there is
 * reported as ignored. In the rule's block they would only make that block skip
 * the file, and the file would still be linted — with no rule on, so it would
 * read clean (measured on ESLint 10.1.0).
 */
export function eslintConfigModule(reading: EslintReading): string {
  const plugin = pluginOf(reading.rule);
  const imports = [
    ...(plugin === null ? [] : [`import plugin from ${json(plugin.pkg)};`]),
    ...(reading.parser === undefined
      ? []
      : [`import parser from ${json(reading.parser)};`]),
  ];
  const block = [
    `files: ${json(reading.scope.files)}`,
    'linterOptions: { reportUnusedDisableDirectives: "off" }',
    ...(plugin === null ? [] : [`plugins: { ${json(plugin.prefix)}: plugin }`]),
    ...(reading.parser === undefined ? [] : ["languageOptions: { parser }"]),
    `rules: { ${json(reading.rule)}: ${json(["error", ...reading.options])} }`,
  ];
  return [
    ...imports,
    "export default [",
    `  { ignores: ${json(reading.scope.ignores)} },`,
    `  { ${block.join(", ")} },`,
    "];",
    "",
  ].join("\n");
}

const reportSchema = z.array(
  z.object({
    filePath: z.string(),
    messages: z.array(
      z.object({
        ruleId: z.string().nullable(),
        fatal: z.boolean().optional(),
        message: z.string(),
      }),
    ),
  }),
);

type Message = z.infer<typeof reportSchema>[number]["messages"][number];

function fileReport(
  path: string,
  messages: readonly Message[],
  rule: string,
): FileReport {
  const fatal = messages.find((m) => m.fatal === true);
  if (fatal !== undefined)
    return { path, kind: "parse-error", message: fatal.message };
  const ignored = messages.some(
    (m) => m.ruleId === null && m.message.startsWith("File ignored"),
  );
  if (ignored) return { path, kind: "ignored" };
  return {
    path,
    kind: "linted",
    hits: messages.filter((m) => m.ruleId === rule).length,
  };
}

/** ESLint's `--format json` as per-file reports. */
export function parseEslintReport(
  stdout: string,
  dir: string,
  rule: string,
): LintParse {
  const parsed = reportSchema.safeParse(jsonArray(stdout));
  if (!parsed.success) return unreadable(stdout);
  return {
    kind: "parsed",
    files: parsed.data.map((f) =>
      fileReport(toRelative(dir, f.filePath), f.messages, rule),
    ),
  };
}

const CONFIG = ".vigiles-rule-proof.config.mjs";

export const eslintKit: ProofKit<EslintReading> = {
  linter: "eslint",
  plan(root) {
    const plan = nodeInstallPlan({
      lockfiles: root.names,
      packageManager: packageManagerIn(root.read("package.json")),
    });
    if (plan.kind === "none")
      return { kind: "none", stage: "no-lockfile", reason: plan.reason };
    return {
      kind: "plan",
      install: plan.install,
      command: (dir) => [join(dir, "node_modules/.bin/eslint")],
      version: (read) => versionIn(read("node_modules/eslint/package.json")),
      missing:
        "the install left no node_modules/eslint: the repository does not depend on it",
    };
  },
  env: nodeCacheEnv,
  // The config sits in the repository, so its plugin imports resolve from the
  // repository's own node_modules.
  invocation: (reading, files, { dir }) => ({
    configPath: join(dir, CONFIG),
    configText: eslintConfigModule(reading),
    args: ["--config", join(dir, CONFIG), "--format", "json", ...files],
  }),
  // 1 is "lint errors found"; 2 is a crash or a config that did not load.
  reportCodes: [0, 1],
  parse: (stdout, _files, reading, dir) =>
    parseEslintReport(stdout, dir, reading.rule),
};
