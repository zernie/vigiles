/**
 * The ONE answer to "which ESLint rules exist in this repo, which are enabled
 * where, and did the config load" — read from ESLint itself.
 *
 * Three callers used to ask ESLint three different ways, and each saw a
 * different repo: `generate types` probed one representative path per
 * (directory, extension) (#352), `enforce()` verification probed one path per
 * config block `files` glob (#351), and the routing catalog asked about
 * `src/index.ts` alone. The same rule could be enabled for one caller and
 * absent for another. This module owns the probe; every caller reads the same
 * {@link EslintInventory}.
 *
 * This module is the pure half (the probe's script, its wire schema, and every
 * question asked of the answer); `eslintInventory` in `linters.ts` runs the
 * probe beside the other linter subprocesses, cached per project.
 *
 * HOW: a child `node -e` process runs in the project's directory, so `eslint`
 * and the config's own imports resolve from the project exactly as `npx eslint`
 * would, and nothing of the project's config loads into our process. The child
 * lists the config's blocks (plugins they register, rules they mention, a probe
 * path synthesized from each `files` glob), adds one representative path per
 * (directory, name shape) of the project's files, and asks
 * `calculateConfigForFile` for each. A rule is `enabled` if any probe has it on,
 * `disabled` if every probe that sets it has it off.
 *
 * LIMITS, named: a block naming one exact file that shares directory and
 * extension with siblings is reached only if its glob synthesizes that path; a
 * config in a SUBDIRECTORY (v10 looks configs up per file) is not listed; a
 * `files` entry given as a function is not probed. A rule that a block mentions
 * but no probe reached reads `unknown`, never `unconfigured`.
 */

import { basename, dirname } from "node:path";
import { z } from "zod";

import type { ConfigEnabledStatus } from "./linter-adapter.js";

/** What ESLint's resolved config says about the repo, when it loaded. */
export interface EslintConfigView {
  /** ESLint's built-in rule ids. */
  readonly core: ReadonlySet<string>;
  /** plugin namespace → its rule names, from the plugin objects ESLint holds. */
  readonly plugins: ReadonlyMap<string, ReadonlySet<string>>;
  /** rule id → state, merged over every probe path. */
  readonly rules: ReadonlyMap<string, "enabled" | "disabled">;
  /** rule ids some block sets, whether or not a probe reached that block. */
  readonly mentioned: ReadonlySet<string>;
  /** every block of the config was listed, so an unmentioned rule is unset. */
  readonly complete: boolean;
}

/**
 * The inventory. Separate members because each is a different instruction to
 * the user: no ESLint, no config, a config that throws, a config that loads and
 * switches nothing on, a config with rules.
 */
export type EslintInventory =
  | { readonly kind: "not-installed" }
  | { readonly kind: "no-config" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "empty"; readonly view: EslintConfigView }
  | { readonly kind: "loaded"; readonly view: EslintConfigView };

/** Upper bound on the (directory, name-shape) probes handed to ESLint. */
const PROBE_CAP = 2000;

/** `src/a.test.ts` → `.test.ts`; a name with no extension (`Makefile`) is its own shape. */
function nameShape(file: string): string {
  const name = basename(file);
  const dot = name.indexOf(".", 1);
  return dot === -1 ? name : name.slice(dot);
}

/**
 * One representative path per distinct (directory, name shape) pair of the
 * project's files. A flat-config `files` glob selects on the directory and the
 * name's extension chain, so one file per pair sees every block any file of
 * that pair could match — without linting a single file.
 */
export function representativePaths(
  files: readonly string[],
): readonly string[] {
  // A later duplicate key replaces an earlier one: one representative per pair.
  const byPair = new Map(
    files.map((f) => [`${dirname(f)}\0${nameShape(f)}`, f] as const),
  );
  return [...byPair.values()].slice(0, PROBE_CAP);
}

/** The files `representativePaths` picks from: everything but dependencies and git. */
export const PROJECT_FILES_GLOB = {
  pattern: "**/*",
  ignore: ["**/node_modules/**", "**/.git/**"],
} as const;

// Plain CommonJS for `node -e`, run with cwd = the project. Reads the
// representative paths as JSON on stdin; prints one JSON object (the wire
// schema below). `messageTemplate` is ESLint's own error id, so "no config" is
// read from a field, not from the wording of a message.
export const ESLINT_PROBE_SCRIPT = String.raw`
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const PROBE = "__vigiles_probe__";
const NO_CONFIG = new Set(["no-config-found", "config-file-missing"]);
function probeFor(pattern, base) {
  if (Array.isArray(pattern)) pattern = pattern[0];
  if (typeof pattern !== "string" || pattern.startsWith("!")) return null;
  let p = pattern
    .replace(/\{([^,}]*)[^}]*\}/g, "$1")
    .replace(/\[!?\^?([^\]])[^\]]*\]/g, "$1")
    .replace(/(^|\/)\*\*\//g, "$1")
    .replace(/\/\*\*$/, "/" + PROBE + ".js")
    .replace(/\*\*/g, PROBE)
    .replace(/\*/g, PROBE)
    .replace(/\?/g, "x");
  if (p.startsWith("./")) p = p.slice(2);
  if (p === "" || path.isAbsolute(p)) return null;
  if (p.endsWith("/")) p += PROBE + ".js";
  return typeof base === "string" ? path.posix.join(base, p) : p;
}
function severityOn(v) {
  const sev = Array.isArray(v) ? v[0] : v;
  return !(sev === 0 || sev === "off");
}
const print = (o) => console.log(JSON.stringify(o));
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  let api;
  try { api = require("eslint"); } catch (e) { return print({ kind: "not-installed" }); }
  const plugins = new Map();
  const addPlugins = (map) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [ns, plugin] of Object.entries(map)) {
      if (ns === "@" || !plugin || typeof plugin !== "object") continue;
      const set = plugins.get(ns) || new Set();
      for (const r of Object.keys(plugin.rules || {})) set.add(r);
      plugins.set(ns, set);
    }
  };
  try {
    const ESLint = await api.loadESLint();
    const eslint = new ESLint({ cwd: process.cwd() });
    const probes = new Set(["dummy.js", "dummy.mjs", "dummy.cjs", ...JSON.parse(input || "[]")]);
    const mentioned = new Set();
    let complete = false;
    if (typeof eslint.findConfigFile === "function") {
      const file = await eslint.findConfigFile();
      if (!file) return print({ kind: "no-config" });
      const mod = await import(pathToFileURL(file).href);
      const blocks = [];
      const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") blocks.push(x); };
      walk(await mod.default);
      for (const b of blocks) {
        addPlugins(b.plugins);
        for (const id of Object.keys(b.rules || {})) mentioned.add(id);
        for (const f of Array.isArray(b.files) ? b.files : []) {
          const probe = probeFor(f, b.basePath);
          if (probe) probes.add(probe);
        }
      }
      complete = true;
    }
    const rules = {};
    for (const probe of probes) {
      const cfg = await eslint.calculateConfigForFile(probe);
      // undefined: the config ignores this path.
      if (!cfg) continue;
      addPlugins(cfg.plugins);
      for (const [id, v] of Object.entries(cfg.rules || {})) {
        rules[id] = rules[id] === "enabled" || severityOn(v) ? "enabled" : "disabled";
      }
    }
    let core = [];
    try { core = [...require("eslint/use-at-your-own-risk").builtinRules.keys()]; } catch (e) {}
    const pluginsOut = {};
    for (const [ns, set] of plugins) pluginsOut[ns] = [...set];
    print({ kind: "loaded", core, plugins: pluginsOut, rules, mentioned: [...mentioned], complete });
  } catch (e) {
    if (e && NO_CONFIG.has(e.messageTemplate)) return print({ kind: "no-config" });
    print({ kind: "failed", error: String((e && e.message) || e).split("\n")[0] });
  }
});
`;

const ruleStateSchema = z.enum(["enabled", "disabled"]);

/** The child's answer. Parsed, never cast: a malformed answer is a failure. */
const wireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-installed") }),
  z.object({ kind: z.literal("no-config") }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({
    kind: z.literal("loaded"),
    core: z.array(z.string()),
    plugins: z.record(z.string(), z.array(z.string())),
    rules: z.record(z.string(), ruleStateSchema),
    mentioned: z.array(z.string()),
    complete: z.boolean(),
  }),
]);

/**
 * Turn the child's stdout into an inventory. Pure, so every shape of answer is
 * testable without spawning ESLint. @internal
 */
export function parseEslintInventory(stdout: string): EslintInventory {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const json = ((): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })();
  const parsed = wireSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "failed", error: `unreadable ESLint probe output: ${line}` };
  }
  const wire = parsed.data;
  if (wire.kind !== "loaded") return wire;
  const view: EslintConfigView = {
    core: new Set(wire.core),
    plugins: new Map(
      Object.entries(wire.plugins).map(([ns, r]) => [ns, new Set(r)]),
    ),
    rules: new Map(Object.entries(wire.rules)),
    mentioned: new Set(wire.mentioned),
    complete: wire.complete,
  };
  const anyEnabled = [...view.rules.values()].includes("enabled");
  return anyEnabled ? { kind: "loaded", view } : { kind: "empty", view };
}

/** The view, when the config loaded (with or without enabled rules). */
export function configView(inv: EslintInventory): EslintConfigView | null {
  return inv.kind === "loaded" || inv.kind === "empty" ? inv.view : null;
}

/** Ids of every rule the config switches on somewhere, sorted. */
export function enabledRuleIds(view: EslintConfigView): readonly string[] {
  return [...view.rules]
    .filter(([, state]) => state === "enabled")
    .map(([id]) => id)
    .sort();
}

/** Enabled state of one rule id across every block of the config. */
export function eslintRuleState(
  inv: EslintInventory,
  ruleId: string,
): ConfigEnabledStatus {
  switch (inv.kind) {
    // No config: ESLint runs no rule anywhere.
    case "no-config":
      return "unconfigured";
    case "not-installed":
    case "failed":
      return "unknown";
    case "empty":
    case "loaded": {
      const state = inv.view.rules.get(ruleId);
      if (state) return state;
      // Set somewhere we could not reach, or the block list was never read: we
      // do not know. Set nowhere in a config we read whole: it runs nowhere.
      if (inv.view.mentioned.has(ruleId) || !inv.view.complete) {
        return "unknown";
      }
      return "unconfigured";
    }
  }
}

/**
 * Does the plugin the config REGISTERS under `ruleId`'s namespace define the
 * rule? null when the config registers no plugin under that namespace (or did
 * not load). The namespace is everything before the LAST slash — ESLint's own
 * split, so `@scope/plugin/rule` works.
 */
export function registeredPluginHasRule(
  inv: EslintInventory,
  ruleId: string,
): boolean | null {
  const slash = ruleId.lastIndexOf("/");
  if (slash <= 0) return null;
  const rules = configView(inv)?.plugins.get(ruleId.substring(0, slash));
  if (!rules) return null;
  return rules.has(ruleId.substring(slash + 1));
}
