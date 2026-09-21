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
 * THE TYPE IS DERIVED FROM THIS, not written beside it: `VigilesConfig` is
 * `z.infer<typeof vigilesConfigSchema>` (see `./types.ts`), so a field cannot
 * exist in the type and not in the validator, which is how `surfaceRoots` ended
 * up documented in `docs/cli.md` for a week after it stopped being read.
 *
 * DEFAULTS LIVE HERE TOO, and that is what makes the derivation exact. Every key
 * the loaded config is guaranteed to carry (`rules`, `files`, `ruleMarkers`)
 * carries a Zod `.default(...)`, and Zod's inferred OUTPUT type for a defaulted
 * field is non-optional — so `z.infer` reproduces the old
 * `rules: Required<RulesConfig>` exactly, rather than approximating it. Parsing
 * `{}` yields byte-for-byte the old `DEFAULT_CONFIG`.
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
const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((v): readonly string[] => (typeof v === "string" ? [v] : v));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Min % thresholds for the `coverage` rule. */
const coverageThresholds = z
  .object({
    /** Min % of enabled linter rules with `enforce()` declarations. */
    linterRules: z.number().optional(),
    /** Min % of npm scripts documented in spec commands. */
    scripts: z.number().optional(),
  })
  .strict();

/** Discovery options shared by the three `untested-*` rules. */
const testCoverageConfig = z
  .object({
    include: stringList.optional(),
    exclude: stringList.optional(),
    testExtension: z.string().optional(),
  })
  .strict();

/**
 * Every validation rule, with its shipped default severity.
 *
 * 🔴 THIS OBJECT IS THE RULE SET. `rules-docs-in-sync` already treats the
 * `RulesConfig` keys as the single source of truth the docs must track; now they
 * are also what the validator accepts, so a rule name that is not here is
 * REJECTED with the near-miss suggested rather than silently ignored — which is
 * the same class of bug as a misspelled harness name, and was equally quiet.
 */
const rulesSchema = z
  .object({
    "spec-refs": severitySchema.default("error"),
    "orphan-docs": severitySchema.default("warn"),
    "duplicate-rules": severitySchema.default("warn"),
    "require-instructions-spec": severitySchema.default("warn"),
    "require-skill-spec": severitySchema.default(false),
    integrity: severitySchema.default("warn"),
    coverage: withOptions(coverageThresholds).default(false),
    "untested-skill": withOptions(testCoverageConfig).default("warn"),
    "untested-subagent": withOptions(testCoverageConfig).default("warn"),
    "untested-hook": withOptions(testCoverageConfig).default("warn"),
    "unmarked-refs": severitySchema.default("warn"),
    "subagent-tool-contract": severitySchema.default("warn"),
    "hook-events": severitySchema.default("warn"),
    "subagent-frontmatter": severitySchema.default("warn"),
    "mcp-config": severitySchema.default("warn"),
    "skill-frontmatter": severitySchema.default("warn"),
    "mcp-tool-resolves": severitySchema.default("warn"),
    "hook-script-exists": severitySchema.default("warn"),
    "prefer-compiled-hooks": severitySchema.default(false),
    "disallowed-tools-contract": severitySchema.default("warn"),
    "description-overlap": severitySchema.default("warn"),
    "skill-description-budget": severitySchema.default("warn"),
    "frontmatter-valid": severitySchema.default("warn"),
    "mcp-hook-target-resolves": severitySchema.default("warn"),
    "lethal-trifecta": severitySchema.default("warn"),
    "skill-resource-resolves": severitySchema.default("warn"),
    "skill-missing-fence": severitySchema.default("warn"),
    "plugin-dir-layout": severitySchema.default("warn"),
    "delegation-trifecta": severitySchema.default("warn"),
    "hook-block-ineffective": severitySchema.default("warn"),
    "hook-matcher": severitySchema.default("warn"),
    "doc-refs": severitySchema.default(false),
  })
  .strict();

/** The rule names, for the "did you mean" on an unknown one. */
export const RULE_NAMES: readonly string[] = Object.keys(rulesSchema.shape);

// ---------------------------------------------------------------------------
// Harnesses (#240)
// ---------------------------------------------------------------------------

/**
 * ONE harness's entry in {@link vigilesConfigSchema}'s `harnesses`.
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

/**
 * The whole of `.vigilesrc.json`.
 *
 * `.strict()` at the top level is the check that did not exist: an unrecognized
 * key is now a named error with a suggestion, where it used to be spread into
 * the config object and never read.
 */
export const vigilesConfigSchema = z
  .object({
    /** Which markdown constructs count as a rule — headings, checkboxes, or both. */
    ruleMarkers: z
      .array(z.enum(["headings", "checkboxes"]))
      .default(["headings", "checkboxes"]),
    rules: rulesSchema.prefault({}),
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
        exclude: stringList.optional(),
      })
      .strict()
      .optional(),
    exclude: stringList.optional(),
    sharedDirs: stringList.optional(),
    harnesses: z.record(z.string(), harnessDeclarationSchema).optional(),
    audit: z.object({ measure: z.boolean().optional() }).strict().optional(),
    eval: z.object({ apiVersion: z.number().optional() }).strict().optional(),
    nudge: z.literal("dismissed").optional(),
    /**
     * The editor's pointer at the published JSON Schema. Accepted, never read.
     *
     * 🔴 IT IS DECLARED HERE RATHER THAN EXCUSED IN THE UNKNOWN-KEY WALKER, and
     * the reason is that the walker is only half the surface. `dist/vigilesrc.
     * schema.json` is generated FROM this object by
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
     * An exception in the walker would have fixed the first line and left the
     * second — a red squiggle on the one line whose entire job is to turn the
     * squiggles on. One declaration, both halves, because both derive from here.
     *
     * It is LAST in the shape on purpose: `knownKeysAt` reads this object to
     * build the "Known: …" candidate list, which is capped, so a key nobody
     * misspells belongs past the cap rather than at the head of the suggestion.
     */
    $schema: z.string().optional(),
  })
  .strict();

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

/**
 * The whole config, AS THE SCHEMA DEFINES IT — `VigilesConfig` is this.
 *
 * Exported from here and re-exported (type-only, so no runtime cycle) by
 * `./types.ts`, which every consumer already imports. The derivation is the
 * point: a key cannot be in the type and absent from the validator.
 */
export type VigilesConfigShape = z.infer<typeof vigilesConfigSchema>;

/**
 * The two keys `harnesses` replaced, and the sentence each one gets (#240).
 *
 * They are listed here rather than left to `.strict()`'s "Unrecognized key"
 * because the reader of that message is someone whose config USED to work: they
 * need the new spelling, not the news that the old one is unknown. `.strict()`
 * would tell them the truth in the least useful possible way.
 */
export const REPLACED_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly was: string;
  readonly now: string;
}> = [
  {
    key: "harness",
    // The literal OLD config text this migration notice quotes back at the user:
    // a historical artefact, not a fact about a harness, so there is no port to
    // read it off. This is the one exemption here that is not debt.
    // eslint-disable-next-line local/no-harness-names -- quoted legacy config
    was: '"harness": ["claude-code", "codex"]',
    now: "a KEY per harness",
  },
  {
    key: "surfaceRoots",
    was: '"surfaceRoots": [".ai"]',
    now: '"roots" INSIDE the harness that reads them',
  },
];

/**
 * The message a config written in the replaced shape gets.
 *
 * `names` are the harnesses the user's OWN config named under the removed
 * `harness` key, so the worked example below shows THEIR migration.
 *
 * 🔴 IT USED TO BE A FIXED EXAMPLE — `{ "harnesses": { "claude-code": …,
 * "codex": {} } }`, two names typed into the core. Its own comment called that
 * debt and predicted the failure: "with a third adapter this sample goes
 * stale". Reading the names from the config being migrated is better than
 * reading them from the registry would have been, and it is available here:
 * it shows the reader their own keys instead of somebody else's.
 */
export function replacedKeyMessage(
  present: ReadonlyArray<(typeof REPLACED_KEYS)[number]>,
  names: readonly string[],
): string {
  // Empty when the config used only `surfaceRoots`, or named no harness — a
  // placeholder the reader will obviously replace, never an invented name.
  const example = (names.length > 0 ? names : ["<harness>"])
    .map((n, i) => `"${n}": ${i === 0 ? '{ "roots": [".ai"] }' : "{}"}`)
    .join(", ");
  return (
    `.vigilesrc.json: ${present.map((k) => `"${k.key}"`).join(" and ")} ` +
    `${present.length === 1 ? "was" : "were"} replaced by one nested key, "harnesses".\n` +
    `  Write:  { "harnesses": { ${example} } }\n` +
    present.map((k) => `  - ${k.was}  →  ${k.now}`).join("\n") +
    `\n  The old harness ARRAY's order silently decided what got read: one order graded the ` +
    `skills and read no instruction file, the other read the instruction file and found no ` +
    `skills. Scoping each root under the harness that reads it removes the order.`
  );
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
function knownKeysAt(path: readonly PropertyKey[]): readonly string[] {
  let node: unknown = vigilesConfigSchema;
  for (const seg of path) {
    const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod
      ?.def;
    if (def?.type === "object") {
      node = (def.shape as Record<string, unknown> | undefined)?.[String(seg)];
    } else if (def?.type === "record") {
      node = def.valueType;
    } else {
      return [];
    }
    if (node === undefined) return [];
    node = unwrap(node);
  }
  const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  return def?.type === "object"
    ? Object.keys(def.shape as Record<string, unknown>)
    : [];
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
export function formatConfigIssues(issues: readonly ConfigIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") return unknownKeyLines(issue);
    if (issue.code === "invalid_union") return [badValueLine(issue)];
    return [
      `.vigilesrc.json: ${pathLabel(issue.path ?? [])} — ${issue.message ?? "invalid"}.`,
    ];
  });
}

/** One line per unrecognized key, with a near-miss or the candidate list. */
function unknownKeyLines(issue: ConfigIssue): string[] {
  const known = knownKeysAt(issue.path ?? []);
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
