/**
 * `.vigilesrc.json`, AS A SCHEMA — the one place the config's shape, its
 * defaults and its error messages live.
 *
 * 🔴 WHY A SCHEMA AND NOT THE HAND-WRITTEN CHECKS IT REPLACED. `loadConfig` used
 * to coerce the keys it happened to remember (`asStringArray` on three of them),
 * spread everything else through untouched, and say nothing at all about a key
 * it had never heard of. MEASURED on this repo's own CLI before the change:
 *
 * ```
 * $ echo '{"surfaceRootz":[".ai"]}' > .vigilesrc.json && vigiles audit .
 * (no complaint about the unknown key — exit 0)
 * ```
 *
 * A key the tool does not read is a line the user believes is working. That is
 * the product's own subject — a passing signal standing in for work nobody did —
 * happening inside the tool, so the shape is now DECLARED and anything outside
 * it is named out loud.
 *
 * THE TYPE IS DERIVED FROM THIS, not written beside it: `VigilesConfigOf` is
 * the static keys' `z.output` plus the rule set's own entries (see `./types.ts`),
 * so a field cannot exist in the type and not in the validator, which is how
 * `surfaceRoots` ended up documented in `docs/cli.md` for a week after it
 * stopped being read.
 *
 * THE RULES ARE A PARAMETER. The `rules` object, its defaults and the presets
 * `extends` accepts are BUILT from the rule set a composition root hands to
 * {@link configFor} — each rule declares its id, default and options schema in
 * its own module (`src/rules/`), and this file names none of them. Every key
 * the loaded config is guaranteed to carry (`rules`, `files`, `ruleMarkers`)
 * carries a Zod `.default(...)`, so parsing `{}` yields every rule at its
 * shipped default (`src/rules/index.test.ts` pins that snapshot).
 *
 * ⚠️ ZOD COSTS ~45 ms TO IMPORT (measured, Zod 4.6.5), AND IT IS IMPORTED
 * NORMALLY — `src/core/validate.ts` has a top-level `import`, not a deferred
 * `require`. The deferral was tried and is recorded there rather than here,
 * because the reason it was dropped is a property of the two worlds this code
 * runs in, not of this file. What matters here: the genuinely hot rail — a
 * compiled hook's decision, `vigiles hook-runtime run-program`, one fresh
 * process per matching tool call — never loads the verb barrel and therefore
 * never loads this module (`src/cli.ts` branches first;
 * `src/hook-runtime-graph.test.ts` fails the day that stops being true). The
 * rails that DO load the barrel already pay ~316 ms of Node startup and ~85
 * requires, against which 45 ms is ~13%.
 */
import { z } from "zod";
import { editDistance } from "./edit-distance.js";
import { PRESET_PREFIX, extendedPresets, presetRulesOf } from "./presets.js";
import { configDefault, type RuleGroups, type RuleSpec } from "./rule.js";
import type { RuleSeverity, RuleWithOptions } from "./types.js";

/** The config file; the directory holding it is a project root. */
export const PROJECT_CONFIG_FILE = ".vigilesrc.json";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A rule's severity as the config may spell it, normalized to the three values
 * the gate actually branches on.
 *
 * 🔴 THE ESLINT SPELLINGS ARE PART OF THE SCHEMA, not a pre-pass. `"off"`, `0`,
 * `false`, `1`, `2` are what people type because every other linter takes them,
 * and before this they fell through the validator untouched and RENDERED AS A
 * WARN — so `"off"` did not turn a rule off and `2` did not make it gate
 * (#112). Putting the transform in the schema means the parsed config only ever
 * holds a real decision, and the "unrecognized value" case is a schema failure
 * with a message rather than a silent downgrade.
 */
const severitySchema = z
  .union([
    z.literal("warn"),
    z.literal("error"),
    z.literal(false),
    z.literal("off"),
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(true),
  ])
  .transform((v): "warn" | "error" | false => {
    if (v === "off" || v === 0 || v === false) return false;
    if (v === "error" || v === 2) return "error";
    return "warn";
  });

/** `severity` alone, or `[severity, options]` — the rules that take options. */
const withOptions = <T extends z.ZodType>(options: T) =>
  z.union([
    severitySchema,
    z.tuple([z.literal("warn"), options]),
    z.tuple([z.literal("error"), options]),
  ]);

/**
 * A string, or a string ARRAY — coerced to an array.
 *
 * The bare-string case is the natural first-value mistake and it used to spread
 * a string's CHARACTERS as globs: `"exclude": "bench"` became
 * `["b","e","n","c","h"]`, which is a no-op at best and garbage `orphan` matches
 * (`.`, `/`, `README.md`) at worst. Accepting it as a one-element array is what
 * `asStringArray` did; the difference is that anything that is neither is now a
 * schema error instead of a `console.warn` nobody reads.
 */
export const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((v): readonly string[] => (typeof v === "string" ? [v] : v));

// ---------------------------------------------------------------------------
// Overrides — per-path severities (`./overrides.ts`)
// ---------------------------------------------------------------------------

/**
 * One `overrides` entry. `files` are root-relative globs with top-level
 * `exclude`'s semantics; an entry with none would apply nowhere, so it is
 * refused rather than kept as a line that does nothing. Its `rules` are every
 * rule, a SEVERITY only, no default: options stay in `rules` — one place — so
 * `["error", { … }]` here is refused rather than accepted and never read.
 */
const overrideSchema = (ruleNames: readonly string[]) =>
  z
    .object({
      files: stringList.refine((globs) => globs.length > 0, {
        message: "needs at least one glob",
      }),
      rules: z
        .object(
          Object.fromEntries(
            ruleNames.map((name) => [name, severitySchema.optional()]),
          ),
        )
        .strict(),
    })
    .strict();

// ---------------------------------------------------------------------------
// Harnesses (#240)
// ---------------------------------------------------------------------------

/**
 * ONE harness's entry in the config's `harnesses`.
 *
 * `.strict()` is load-bearing here specifically: the whole reason this key
 * exists is that a declaration which reaches nothing used to be silent, and
 * `{"claude-code": {"root": ".ai"}}` (singular, no `s`) reaches nothing.
 */
const harnessDeclarationSchema = z
  .object({
    roots: stringList.optional(),
  })
  .strict();

/** The harness keys' value shape, exported so `types.ts` can derive the type. */
export type HarnessDeclarationShape = z.infer<typeof harnessDeclarationSchema>;

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

/** What counts as a rule in markdown, by default: both constructs. */
export const DEFAULT_RULE_MARKERS = ["headings", "checkboxes"] as const;

/**
 * The keys of `.vigilesrc.json` that do not depend on the rule set, in the
 * order the "Known: …" list prints them (it is capped, so the keys people
 * misspell most come first). `rules`, `overrides` and `extends` are built from
 * the rule set by {@link configFor} and slotted in around these.
 */
const configKeys = {
  /** Which markdown constructs count as a rule — headings, checkboxes, or both. */
  ruleMarkers: z
    .array(z.enum(DEFAULT_RULE_MARKERS))
    .default([...DEFAULT_RULE_MARKERS]),
  /** The instruction files to validate. */
  files: z.array(z.string()).default(["CLAUDE.md"]),
  maxRules: z.number().optional(),
  maxTokens: z.number().optional(),
  maxSectionLines: z.number().optional(),
  catalogOnly: z.boolean().optional(),
  linters: z
    .record(
      z.string(),
      z
        .object({
          // NOT `stringList`: this value is handed to the linter catalog
          // layer as written (`string | string[]`), and normalizing it here
          // would change a published shape for no gain — the consumer already
          // handles both. Accepting exactly what it accepts is the point.
          rulesDir: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .strict(),
    )
    .optional(),
  bundles: z.enum(["root", "all"]).optional(),
  orphans: z
    .object({
      include: stringList.optional(),
    })
    .strict()
    .optional(),
  exclude: stringList.optional(),
};

/** The keys after `overrides`; `extends` and `$schema` close the shape. */
const configTailKeys = {
  sharedDirs: stringList.optional(),
  harnesses: z.record(z.string(), harnessDeclarationSchema).optional(),
  audit: z.object({ measure: z.boolean().optional() }).strict().optional(),
  eval: z.object({ apiVersion: z.number().optional() }).strict().optional(),
  nudge: z.literal("dismissed").optional(),
};

/**
 * The editor's pointer at the published JSON Schema. Accepted, never read.
 *
 * 🔴 IT IS DECLARED HERE RATHER THAN EXCUSED IN THE UNKNOWN-KEY WALKER, and
 * the reason is that the walker is only half the surface. `dist/vigilesrc.
 * schema.json` is generated FROM this schema by
 * `scripts/build-config-schema.mjs`, with `additionalProperties: false`, so
 * a key missing here is refused TWICE: once by the CLI, and once by the
 * editor being pointed at the schema. Measured before this key existed, on
 * `{"$schema": <the schema's own $id>, "harnesses": {"claude-code": {}}}`:
 *
 * ```
 * $ vigiles audit . --no-interactive
 * ✗ .vigilesrc.json: unknown key "$schema" in (top level). Known: …
 * (exit 2)
 * $ # and the same document against dist/vigilesrc.schema.json:
 * additionalProperties: should NOT have additional properties ($schema)
 * ```
 *
 * It is LAST in the shape on purpose: `knownKeysAt` reads the schema to build
 * the "Known: …" candidate list, which is capped, so a key nobody misspells
 * belongs past the cap rather than at the head of the suggestion.
 */
const schemaPointer = z.string().optional();

/** The keys that do not depend on the rule set, as one object type. */
type StaticConfig = z.output<
  z.ZodObject<
    typeof configKeys &
      typeof configTailKeys & { readonly $schema: typeof schemaPointer }
  >
>;

/** One rule's entry in `rules`: a severity, or `[severity, options]`. */
export type RuleEntry = RuleWithOptions<unknown>;

/** The `rules` of a config, keyed by rule id. */
export type RulesConfig<Id extends string = string> = {
  readonly [K in Id]: RuleEntry;
};

/** The config entry a rule takes: with its options' type when it has options. */
type EntryOf<S> = S extends { readonly options: infer O extends z.ZodType }
  ? RuleWithOptions<z.output<O>>
  : RuleSeverity;

/**
 * The PRECISE `rules` of a rule set — each id with its own options type. The
 * composition root instantiates it over `RULES`; generic code takes
 * {@link RulesConfig} and never names an id (the `local/no-rule-ids` fence).
 */
export type RulesConfigOf<R extends readonly RuleSpec[]> = {
  readonly [S in R[number] as S["id"]]: EntryOf<S>;
};

/**
 * The whole parsed config: the static keys as the schema defines them, plus
 * the rule set's `rules` and `overrides`. Exported from here and re-exported
 * (type-only) by `./types.ts`; a key cannot be in the type and absent from the
 * validator.
 */
export type VigilesConfigOf<Rules> = StaticConfig & {
  rules: Rules;
  overrides?: readonly {
    readonly files: readonly string[];
    readonly rules: { readonly [K in keyof Rules]?: RuleSeverity };
  }[];
  extends?: string | readonly string[];
};

/** A parse of a raw config: the config, or the issues that refused it. */
export type ConfigParse<C> =
  | { readonly success: true; readonly data: C }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly ConfigIssue[] };
    };

/**
 * `.vigilesrc.json` for one rule set — the schema, its presets and its
 * defaults, BUILT from the rules a composition root hands in. `C` is the parsed
 * config's type: precise (`VigilesConfigOf<RulesConfigOf<typeof RULES>>`) at
 * the root, string-keyed in generic code.
 */
export interface ConfigSet<C> {
  /** The whole schema — for the JSON Schema build and the error messages. */
  readonly schema: z.ZodType;
  /** Every rule id the schema accepts, in the set's order. */
  readonly ruleNames: readonly string[];
  /** The preset names `extends` and `--preset=` accept, from the groups. */
  readonly presetNames: readonly string[];
  /**
   * Parse a raw `.vigilesrc.json` value — THE one entry point every reader uses.
   *
   * 🔴 THE PRESET IS MERGED INTO THE RAW INPUT, BEFORE THE SCHEMA: after
   * parsing, every rule carries a value (the schema fills each default), so
   * "the user wrote `hook-events: warn`" and "nobody wrote it" are the same
   * output, and an explicit downgrade could not win over the preset. Before
   * parsing, the user's own `rules` keys are exactly what they wrote, so the
   * preset's severities go UNDER them. Only a recognized preset with an object
   * (or absent) `rules` is expanded; anything else is passed through for the
   * schema to refuse with its own message.
   *
   * `extraPresets` — `audit`/`lint --preset=<name>` for one run — go after the
   * file's own presets (so they win over them) and never over its explicit
   * `rules`. They are not written into the parsed `extends`: that key stays
   * what the FILE says.
   */
  parse(raw: unknown, extraPresets?: readonly string[]): ConfigParse<C>;
}

/** Each rule's key with its default and, with `options`, the tuple form. */
function rulesSchemaOf(rules: readonly RuleSpec[]) {
  return z
    .object(
      Object.fromEntries(
        rules.map((r) => [
          r.id,
          (r.options ? withOptions(r.options) : severitySchema).default(
            configDefault(r),
          ),
        ]),
      ),
    )
    .strict();
}

/** The whole schema, `rules`/`overrides`/`extends` slotted in key order. */
function configSchemaOf(
  rules: readonly RuleSpec[],
  presetNames: readonly string[],
) {
  const presetName = z.enum(presetNames);
  const { ruleMarkers, ...bodyKeys } = configKeys;
  return z
    .object({
      ruleMarkers,
      rules: rulesSchemaOf(rules).prefault({}),
      ...bodyKeys,
      /**
       * Per-path rule severities, ESLint's `{ files, rules }` list: a later
       * entry wins over an earlier one, any entry over `rules`, `rules` over
       * `extends`. Resolved by `ruleResolver` (`../overrides.ts`).
       */
      overrides: z.array(overrideSchema(rules.map((r) => r.id))).optional(),
      ...configTailKeys,
      /**
       * A named preset (or a list of them) whose rule severities apply UNDER
       * `rules` — ESLint's `extends`. A later preset wins over an earlier one,
       * and an explicit `rules` entry overrides them all. Applied by `parse`,
       * which is why this key is only VALIDATED here.
       */
      extends: z.union([presetName, z.array(presetName)]).optional(),
      $schema: schemaPointer,
    })
    .strict();
}

/** The core config type: every rule, by a string id. */
type VigilesConfig = VigilesConfigOf<RulesConfig>;

/**
 * Build `.vigilesrc.json` for a rule set: each rule's key with its default and,
 * for a rule with `options`, the `[severity, options]` form; `overrides` over
 * the same ids; `extends` over the groups' preset names.
 *
 * The one place Zod cannot carry the type: an object built from
 * `Object.fromEntries` has string keys, so the parse result is narrowed to the
 * set's precise type by `complete`, which checks at run time that every id is
 * present — never by an assertion.
 */
export function configFor<const R extends readonly RuleSpec[]>(
  rules: R,
  groups: RuleGroups,
): ConfigSet<VigilesConfigOf<RulesConfigOf<R>>> {
  const ruleNames = rules.map((r) => r.id);
  const presets = Object.values(groups).flatMap((g) => g.preset?.name ?? []);
  const presetNames = [...new Set(presets)];
  const schema = configSchemaOf(rules, presetNames);
  const presetRules = presetRulesOf(rules, groups);
  const complete = (
    c: Readonly<VigilesConfig>,
  ): c is VigilesConfigOf<RulesConfigOf<R>> =>
    ruleNames.every((id) => id in c.rules);
  return {
    schema,
    ruleNames,
    presetNames,
    parse(raw, extraPresets = []) {
      const parsed = schema.safeParse(
        withPresetRules(raw, presetNames, presetRules, extraPresets),
      );
      if (!parsed.success) return parsed;
      const data: Readonly<VigilesConfig> = parsed.data;
      if (!complete(data))
        throw new Error("configFor: a parsed config lost a rule");
      return { success: true, data };
    },
  };
}

/** `raw` with its presets' rules placed under its own `rules`, in order. */
function withPresetRules(
  raw: unknown,
  known: readonly string[],
  presetRules: (name: string) => Readonly<Record<string, unknown>>,
  extraPresets: readonly string[],
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const extended = extendedPresets(
    known,
    "extends" in raw ? raw.extends : undefined,
  );
  if (extended === null) return raw;
  const layer = [...extended, ...extraPresets].reduce<
    Readonly<Record<string, unknown>>
  >((acc, name) => ({ ...acc, ...presetRules(name) }), {});
  return withRulesUnder(raw, layer);
}

/**
 * `raw` with `layer` placed UNDER its own `rules`. A non-object `rules` is left
 * for the schema to refuse with its own message.
 */
function withRulesUnder(
  raw: object,
  layer: Readonly<Record<string, unknown>>,
): unknown {
  if (Object.keys(layer).length === 0) return raw;
  const rules = "rules" in raw ? raw.rules : undefined;
  if (rules === undefined) return { ...raw, rules: layer };
  if (typeof rules !== "object" || rules === null || Array.isArray(rules))
    return raw;
  return { ...raw, rules: { ...layer, ...rules } };
}

/** The non-empty, trimmed entries of a comma list. */
function commaList(value: string): readonly string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Parse the values of `--preset=` (each may be a comma list) into preset
 * names, through the SAME enum `extends` validates with, so the config file
 * and the command line refuse an unknown name with the same message. The
 * `vigiles:` prefix is optional on the command line: `--preset=experimental`
 * and `--preset=vigiles:experimental` are the same preset.
 */
export function parsePresetFlags(
  known: readonly string[],
  values: readonly string[],
):
  | { readonly ok: true; readonly presets: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  const short = known.map((n) => n.slice(PRESET_PREFIX.length)).join(", ");
  const names = values.flatMap(commaList);
  if (names.length === 0 && values.length > 0)
    return { ok: false, message: `--preset: needs a name. Known: ${short}.` };
  const presetName = z.enum(known);
  const parsed = names.map((given) => ({
    given,
    result: presetName.safeParse(
      given.startsWith(PRESET_PREFIX) ? given : `${PRESET_PREFIX}${given}`,
    ),
  }));
  const bad = parsed.find((p) => !p.result.success);
  if (bad !== undefined && !bad.result.success)
    return {
      ok: false,
      message: `--preset: unknown preset "${bad.given}" — ${bad.result.error.issues[0]?.message ?? "invalid"}. Known: ${short}.`,
    };
  const ok = parsed.flatMap((p) => (p.result.success ? [p.result.data] : []));
  return { ok: true, presets: [...new Set(ok)] };
}

/**
 * A `.vigilesrc.json` that cannot be honoured as written.
 *
 * 🔴 IT HAS ITS OWN CLASS BECAUSE THE READER CATCHES EVERYTHING ELSE. A missing
 * file, an unreadable one and malformed JSON all mean "use the defaults", which
 * is right — and a file that IS readable and says something we refuse must not
 * join them, or the user's declaration vanishes into the defaults and the run
 * looks clean. A distinct class is what lets the CLI print it as a config error
 * and a hook rail downgrade it to a warning, from one throw site.
 */
export class VigilesConfigError extends Error {
  override readonly name = "VigilesConfigError";
}

// ---------------------------------------------------------------------------
// Messages — the half a schema library does NOT give you
// ---------------------------------------------------------------------------

/**
 * The keys a given config path accepts, walked out of the schema itself.
 *
 * Derived rather than listed, for the reason every other derivation in this repo
 * is: a hand-written candidate list is the copy that goes stale, and the message
 * would then suggest a key the validator rejects. Returns `[]` where the path has
 * no fixed key set (a record's own keys are open — the harness NAMES are checked
 * by `resolveDeclaredHarnesses` against the adapter registry, which core may not
 * import).
 */
function knownKeysAt(
  schema: Readonly<z.ZodType>,
  path: readonly PropertyKey[],
): readonly string[] {
  let node: unknown = schema;
  for (const seg of path) {
    node = childAt(node, seg);
    if (node === undefined) return [];
    node = unwrap(node);
  }
  const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  return def?.type === "object"
    ? Object.keys(def.shape as Record<string, unknown>)
    : [];
}

/**
 * One step down a schema node: an object's field `seg`, an array's element, a
 * record's value. `undefined` where the node has no child to step into.
 */
function childAt(node: unknown, seg: PropertyKey): unknown {
  const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (def?.type === "object")
    return (def.shape as Record<string, unknown> | undefined)?.[String(seg)];
  if (def?.type === "array") return def.element;
  if (def?.type === "record") return def.valueType;
  return undefined;
}

/** Peel `.optional()` / `.default()` / `.prefault()` wrappers off a schema node. */
function unwrap(node: unknown): unknown {
  let cur = node;
  for (let i = 0; i < 8; i++) {
    const def = (cur as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    const inner = def?.innerType;
    if (inner === undefined) return cur;
    cur = inner;
  }
  /* v8 ignore next -- eight wrappers deep is not a shape this schema has */
  return cur;
}

/** How far a "did you mean" may reach before it starts mis-suggesting. */
const SUGGEST_MAX_DISTANCE = 3;

/** The nearest candidate to `name`, or undefined when none is close enough. */
function nearest(
  name: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestD = SUGGEST_MAX_DISTANCE + 1;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= SUGGEST_MAX_DISTANCE ? best : undefined;
}

/** How many candidates a message prints before it stops being a list. */
const MAX_CANDIDATES_SHOWN = 12;

/** The candidate list, capped, with the remainder counted rather than dropped. */
function listCandidates(known: readonly string[]): string {
  if (known.length <= MAX_CANDIDATES_SHOWN) return known.join(", ");
  const shown = known.slice(0, MAX_CANDIDATES_SHOWN).join(", ");
  return `${shown}, … and ${String(known.length - MAX_CANDIDATES_SHOWN)} more`;
}

/** `harnesses.claude-code.roots` — a path a user can find in their own file. */
function pathLabel(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(top level)" : path.map(String).join(".");
}

/**
 * Turn a Zod failure into the lines a human acts on — ONE per real problem.
 *
 * 🔴 THE FORMATTER IS THE POINT, because the library's own message is worse than
 * what it replaced on the two things that matter. Measured on Zod 4.6.5 against
 * this schema:
 *
 * ```
 * {"rules":{"spec-refs":"errr"}}
 *   -> invalid_union, EIGHT branch errors: expected "warn" / "error" / false /
 *      "off" / 0 / 1 / 2 / true — one line per union member, none of them the
 *      sentence "these are the values this key takes"
 * {"harnessez":{}}
 *   -> Unrecognized key: "harnessez"   (names the culprit, suggests nothing)
 * ```
 *
 * The first is CASCADE NOISE: a union failure is one problem, not eight, and
 * printing the branches makes the schema's internals the user's problem. The
 * second is the regression we refuse to ship — the line it would replace is
 * `✗ Unknown harness "claud-code". Known: claude-code, codex.`, which names the
 * candidates AND the near-miss. So a union collapses to one line listing what
 * the key accepts, and an unknown key carries the candidate list plus a
 * distance-bounded "did you mean".
 */
export function formatConfigIssues(
  schema: Readonly<z.ZodType>,
  issues: readonly ConfigIssue[],
): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys")
      return unknownKeyLines(schema, issue);
    if (issue.code === "invalid_union") return unionLines(issue);
    return [
      `.vigilesrc.json: ${pathLabel(issue.path ?? [])} — ${issue.message ?? "invalid"}.`,
    ];
  });
}

/** One line per unrecognized key, with a near-miss or the candidate list. */
function unknownKeyLines(
  schema: Readonly<z.ZodType>,
  issue: ConfigIssue,
): string[] {
  const known = knownKeysAt(schema, issue.path ?? []);
  const where = pathLabel(issue.path ?? []);
  return (issue.keys ?? []).map((key) => {
    // A near-miss REPLACES the candidate list rather than joining it. The rules
    // object has 32 keys, and printing all of them beside
    // `Did you mean "spec-refs"?` buries the one line that is the answer. With
    // no near-miss the list IS the answer, so it is printed (capped — a wall of
    // 32 names is not a list a reader uses either).
    const near = nearest(key, known);
    if (near !== undefined)
      return `.vigilesrc.json: unknown key "${key}" in ${where}. Did you mean "${near}"?`;
    if (known.length === 0)
      return `.vigilesrc.json: unknown key "${key}" in ${where}.`;
    return `.vigilesrc.json: unknown key "${key}" in ${where}. Known: ${listCandidates(known)}.`;
  });
}

/**
 * A failed union: the one line listing what the key accepts — UNLESS a branch
 * got past the union's own position and failed INSIDE its options
 * (`["error", {"max": 1.5}]` matches the tuple's shape and fails at index 1).
 * That inner issue is the problem the author has; "not one of the accepted
 * values" would send them to re-read a list that was never wrong. Zod already
 * collapses an inner failure of a non-type kind (`max: 0` → "Too small"); a type
 * failure (`1.5`, `"4"`) is the case it leaves as a bare union.
 *
 * "Inside" means a path of two or more: index 0 of a `[severity, options]`
 * tuple is the severity itself, and a wrong severity (`["errr", {}]`) is still
 * the accepted-values line. Both tuple branches (`warn` / `error`) report the
 * same inner issue, so it is de-duplicated.
 */
function unionLines(issue: ConfigIssue): readonly string[] {
  const here = issue.path ?? [];
  const inner = (issue.errors ?? [])
    .flat()
    .filter((e) => (e.path ?? []).length >= 2 && e.code !== "invalid_union")
    .map(
      (e) =>
        `.vigilesrc.json: ${pathLabel([...here, ...(e.path ?? [])])} — ${e.message ?? "invalid"}.`,
    );
  return inner.length === 0 ? [badValueLine(issue)] : [...new Set(inner)];
}

/** ONE line for a failed union — never one per branch. */
function badValueLine(issue: ConfigIssue): string {
  const accepted = acceptedValues(issue);
  return (
    `.vigilesrc.json: ${pathLabel(issue.path ?? [])} is not one of the accepted values` +
    (accepted.length > 0 ? ` (${accepted.join(", ")}).` : ".")
  );
}

/** The literal values / types a union's branches accept, de-duplicated. */
function acceptedValues(issue: ConfigIssue): readonly string[] {
  const named = (issue.errors ?? []).flat().flatMap((b) => {
    if (b.values !== undefined) return b.values.map((v) => JSON.stringify(v));
    return b.expected !== undefined ? [b.expected] : [];
  });
  return [...new Set(named)];
}

/**
 * The shape of a Zod issue this formatter reads — structural, not imported.
 *
 * Zod's own `$ZodIssue` union is exhaustive over every code the library can
 * emit, and switching on it would make adding a schema construct a compile
 * error in a message formatter that has a perfectly good default branch. The
 * fields below are the ones read; everything else falls through to `message`.
 */
export interface ConfigIssue {
  readonly code?: string;
  readonly path?: readonly PropertyKey[];
  readonly message?: string;
  readonly keys?: readonly string[];
  readonly expected?: string;
  readonly values?: readonly unknown[];
  readonly errors?: ReadonlyArray<readonly ConfigIssue[]>;
}
