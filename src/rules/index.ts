/**
 * THE RULE SET — every lint rule vigiles ships, in one tuple, assembled here in
 * the outer rule layer and handed to core by the composition roots
 * (`src/cli-main.ts`, the browser demo's entry). Core declares the port
 * (`../core/rule.ts`) and never imports this file; `boundaries` refuses it.
 *
 * A rule is a module `./<id>.ts` (`defineRule`), imported here and listed in
 * {@link RULES}. The rules not yet migrated to their own module are ROWS below,
 * which is why this one file may spell every id (`local/no-rule-ids` exempts
 * it); each row leaves when its rule becomes a module (vigiles#390).
 *
 * The order is the config schema's key order — the JSON Schema an editor reads
 * and the "Known: …" list an unknown rule name gets both follow it.
 *
 * Adding a rule: its module (or row), its line in `RULES`, its
 * `docs/rules/<id>.md` and its row in `docs/verifying-instruction-files.md`.
 * `./index.test.ts` fails on a missing doc, matrix row or group.
 */
/* eslint-disable sonarjs/no-duplicate-string -- a table of rule rows repeats its column values ("edit", a bucket, a surface); a constant per cell would hide the row. */
import { z } from "zod";

import {
  stringList,
  type RulesConfigOf,
  type VigilesConfigOf,
} from "../core/config-schema.js";
import { defineRule, type RuleSpec } from "../core/rule.js";
import { RULE_GROUPS, type RuleGroupName } from "./groups.js";

export { RULE_GROUPS };

/** Min % thresholds for the `coverage` rule. */
const coverageThresholds = z
  .object({
    /** Min % of enabled linter rules with `enforce()` declarations. */
    linterRules: z.number().optional(),
    /** Min % of npm scripts documented in spec commands. */
    scripts: z.number().optional(),
  })
  .strict();

/**
 * Discovery options shared by the `untested-*` rules. `include` is where tests
 * live — a real option of the rule. Skipping paths is not: that is `overrides`
 * with the rule off.
 */
const testCoverageConfig = z
  .object({
    include: stringList.optional(),
    testExtension: z.string().optional(),
  })
  .strict();

/**
 * Options for `instruction-weight`. `max` is an opt-in ABSOLUTE ceiling on the
 * always-loaded total, in the harness's own unit — independent of the ratchet's
 * baseline. A positive integer: `0` would fail every repo that has an
 * instruction file, and `"40000"` is a string the author meant as a number.
 */
const instructionWeightConfig = z
  .object({
    max: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Thresholds for `compile-budget`, in characters. Each one left out keeps its
 * built-in default; `0` turns that one budget off.
 */
const compileBudgetThresholds = z
  .object({
    /** One `commands` description. */
    maxEntryChars: z.number().optional(),
    /** One named prose section. */
    maxSectionChars: z.number().optional(),
    /** The whole rendered Rules section. */
    maxRulesChars: z.number().optional(),
  })
  .strict();

/** Every rule, in the config schema's key order. */
export const RULES = [
  defineRule({
    id: "spec-refs",
    group: "structural",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "error",
    cure: "edit",
    summary:
      "A compiled instruction file whose spec references a file/script that no longer exists.",
    detector: "compileClaude",
  }),
  defineRule({
    id: "orphan-docs",
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["docs"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Opt-in: a doc in a configured dir (default docs/) that no other .md references.",
    detector: "findOrphanDocs",
  }),
  defineRule({
    id: "duplicate-rules",
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Near-duplicate rules within one spec (NCD similarity) — two rules saying the same thing.",
    detector: "findDuplicateRules",
  }),
  defineRule({
    id: "require-instructions-spec",
    group: "structural",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: { cli: "init" },
    summary: "A .spec.ts exists behind each CLAUDE.md / AGENTS.md.",
    detector: "spec-presence (cli)",
  }),
  defineRule({
    id: "require-skill-spec",
    // Off by default and curable only through `experimental_skill`, so it
    // never gates: `nudge`, beside `hand-written-hook`.
    group: "nudge",
    bucket: "external-decidable",
    surface: ["skill"],
    defaultSeverity: "off",
    cure: { export: "experimental_skill" },
    summary: "A .spec.ts exists behind each SKILL.md (opt-in).",
    detector: "spec-presence (cli)",
  }),
  defineRule({
    id: "integrity",
    // `nudge` for now, at its `warn` default; it moves to `structural` (and so
    // to `error` under `vigiles:recommended`) in the next major release.
    group: "nudge",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: { cli: "compile" },
    summary: "A compiled instruction file still matches its spec's SHA-256.",
    detector: "checkIntegrity",
    upstreamPrevention:
      "compile stamps the hash; this catches later hand-edits",
  }),
  defineRule({
    id: "coverage",
    group: "workflow",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "off",
    cure: "edit",
    summary: "The spec covers ≥ threshold of linter rules / npm scripts.",
    detector: "analyzeCoverage",
    options: coverageThresholds,
  }),
  defineRule({
    id: "untested-skill",
    group: "workflow",
    bucket: "external-decidable",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A SKILL.md ships with a test or eval.",
    detector: "findUntestedSurfaces",
    options: testCoverageConfig,
  }),
  defineRule({
    id: "untested-subagent",
    group: "workflow",
    bucket: "external-decidable",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent (agents/*.md) ships with a test or eval.",
    detector: "findUntestedSurfaces",
    options: testCoverageConfig,
  }),
  defineRule({
    id: "untested-hook",
    group: "workflow",
    bucket: "external-decidable",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A file-backed hook script ships with a test or eval.",
    detector: "findUntestedSurfaces",
    options: testCoverageConfig,
  }),
  defineRule({
    id: "untested-output-style",
    group: "workflow",
    bucket: "external-decidable",
    surface: ["output-style"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "An output style ships with a test or eval.",
    detector: "findUntestedSurfaces",
    options: testCoverageConfig,
  }),
  defineRule({
    id: "unmarked-refs",
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "Code-shaped refs in an instruction file are marked (verifiable).",
    detector: "collectRefIssues",
  }),
  defineRule({
    id: "subagent-tool-contract",
    group: "structural",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent's tools: are all real (no never-available / typo).",
    detector: "verifyToolContract / scoredIssues",
    upstreamPrevention:
      "typed experimental_agent() vocabulary + compileAgent — an unknown tool is a tsc/compile error",
  }),
  defineRule({
    id: "hook-events",
    group: "structural",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A hook's event name is one the harness defines (it can fire).",
    detector: "verifyHookEvents / scoredIssues",
    upstreamPrevention: "compiled hook on: is dialect-validated at compile",
  }),
  defineRule({
    id: "subagent-frontmatter",
    group: "structural",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent has required name/description + valid model/color.",
    detector: "frontmatterIssuesFor",
    upstreamPrevention: "compileAgent emits the required frontmatter",
  }),
  defineRule({
    id: "mcp-config",
    group: "structural",
    bucket: "structural-closed",
    surface: ["mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A declared MCP server can start (has a command or url).",
    detector: "verifyMcpServers",
  }),
  defineRule({
    id: "skill-frontmatter",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A SKILL.md declares an explicit name + description (reliable trigger).",
    detector: "skillMetaIssuesFor",
    upstreamPrevention: "skill() compiler emits name + description",
  }),
  defineRule({
    id: "mcp-tool-resolves",
    group: "structural",
    bucket: "external-decidable",
    surface: ["subagent", "mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent's mcp__server__tool names a declared server.",
    detector: "verifyMcpToolServers",
  }),
  defineRule({
    id: "hook-script-exists",
    group: "structural",
    bucket: "external-decidable",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: { cli: "compile" },
    summary:
      "A file a compiled hook line needs (runtime, program, stamp) exists.",
    detector: "scanHooks over the hook-line plan (status 'missing')",
    upstreamPrevention:
      "a compiled hook is self-contained (no external script)",
  }),
  defineRule({
    id: "hand-written-hook",
    // OFF: its only cure is a compiled hook, an experimental API
    // (docs/experimental.md); it joins `structural` when they leave it.
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["hook"],
    defaultSeverity: "off",
    cure: { export: "experimental_defineHook" },
    summary:
      "A hook line vigiles did not write is named: a static reader cannot verify it, so compile it.",
    detector: "scanHooks (handWritten: no planned line matches)",
    upstreamPrevention: "a compiled hook's line is written by compile itself",
  }),
  defineRule({
    id: "disallowed-tools-contract",
    group: "structural",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A disallowedTools: entry isn't a typo that blocks nothing.",
    detector: "disallowedToolIssues",
    upstreamPrevention:
      "typed experimental_agent() vocabulary (a typo is a tsc error)",
  }),
  defineRule({
    id: "description-overlap",
    group: "structural",
    bucket: "heuristic-behavioral",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Two model-invocable skills aren't near-identical (wrong one fires).",
    detector: "findDescriptionOverlaps",
  }),
  defineRule({
    id: "skill-description-budget",
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A model-invocable skill's description isn't so long the trigger is buried.",
    detector: "findDescriptionBudgetIssues",
  }),
  defineRule({
    id: "compile-budget",
    group: "structural",
    // Exact once a threshold is chosen: a length or a count read off the spec
    // and its rendered output. The threshold is the judgment: the default stays
    // `warn`, and `vigiles:recommended` sets `error`.
    bucket: "structural-closed",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A compiled instruction file stays within its size budgets (command entries, sections, the Rules total).",
    detector: "checkContentBudgets",
    upstreamPrevention:
      "compile measures the spec before writing; a render policy (enforce render, guidance details) meets a budget without deleting a rule",
    options: compileBudgetThresholds,
  }),
  defineRule({
    id: "frontmatter-valid",
    group: "nudge",
    bucket: "heuristic-behavioral",
    surface: ["skill", "subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A --- block parses as YAML (js-yaml is stricter than some loaders).",
    detector: "malformedFrontmatterFor",
    upstreamPrevention: "the spec compiler emits valid frontmatter",
  }),
  defineRule({
    id: "mcp-hook-target-resolves",
    group: "structural",
    bucket: "external-decidable",
    surface: ["hook", "mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A type:mcp_tool hook action is complete + names a declared server.",
    detector: "verifyMcpHookTargets",
  }),
  defineRule({
    id: "lethal-trifecta",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["skill", "subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No unit's tools hold all three lethal-trifecta legs at once.",
    detector: "lethalTrifectaIssues",
  }),
  defineRule({
    id: "skill-resource-resolves",
    group: "experimental",
    bucket: "external-decidable",
    surface: ["skill"],
    // OFF: in the `experimental` group — 44% measured precision.
    // See docs/rules/skill-resource-resolves.md.
    defaultSeverity: "off",
    cure: "edit",
    summary: "A SKILL.md's bundled-file reference exists under the skill dir.",
    detector: "skillResourceIssues",
  }),
  defineRule({
    id: "skill-missing-fence",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A SKILL.md opens with a --- fence (else it loads as inert body).",
    detector: "skillMissingFence",
    upstreamPrevention: "skill() compiler always emits the fence",
  }),
  defineRule({
    id: "plugin-dir-layout",
    group: "nudge",
    bucket: "external-decidable",
    surface: ["plugin"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No functional surface dir is nested inside the manifest dir.",
    detector: "pluginDirLayoutIssues",
    upstreamPrevention: "init scaffolds surfaces at the plugin root",
  }),
  defineRule({
    id: "delegation-trifecta",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No subagent's (own ∪ delegated) capability forms a trifecta.",
    detector: "delegationTrifectaIssues",
  }),
  defineRule({
    id: "hook-block-ineffective",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A hook that looks like it blocks actually can (event + field).",
    detector: "hookBlockIssues",
    upstreamPrevention:
      "compiled hooks — deny compiles to exit 2; the field/exit code is never hand-written",
  }),
  defineRule({
    id: "hook-matcher",
    group: "nudge",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A hook matcher fires as written (no tool-name typo, no MCP pattern that reaches nothing or misses real server names).",
    detector: "hookMatcherIssues",
    upstreamPrevention: "compiled hook tool()/tools() matcher is typed",
  }),
  defineRule({
    id: "doc-refs",
    // OFF for a measured reason, not a rollout one: 0 true positives over
    // 2 582 markdown files — a fence in prose is a drawing of config.
    group: "nudge",
    bucket: "external-decidable",
    surface: ["docs"],
    defaultSeverity: "off",
    cure: "edit",
    summary:
      "Builder calls quoted in markdown ```ts fences resolve for real (opt-in: a fence is usually a drawing of config, not config).",
    detector: "findDocRefs",
  }),
  defineRule({
    id: "instruction-weight",
    group: "structural",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "error",
    cure: "edit",
    summary:
      "The always-loaded instruction weight did not move off its committed baseline.",
    detector: "compareToBaseline",
    options: instructionWeightConfig,
  }),
  defineRule({
    id: "deprecated-key-files",
    // A deprecation notice: it must never gate, or upgrading vigiles would turn
    // a consumer's CI red — the very thing the one-major window exists to avoid.
    group: "nudge",
    bucket: "structural-closed",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "An instruction spec doesn't use the deprecated keyFiles (always-loaded file map).",
    detector: "findDeprecatedKeyFiles",
    upstreamPrevention: "the @deprecated keyFiles field is removed next major",
  }),
] as const satisfies readonly (RuleSpec & { readonly group: RuleGroupName })[];

/** A rule id of the shipped set. */
export type RuleId = (typeof RULES)[number]["id"];

/** The shipped set's `rules`, each id with its own options type. */
export type RulesConfig = RulesConfigOf<typeof RULES>;

/** The shipped set's parsed `.vigilesrc.json` — the root's precise config type. */
export type VigilesConfig = VigilesConfigOf<RulesConfig>;
