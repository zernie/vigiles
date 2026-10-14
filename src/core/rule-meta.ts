/**
 * vigiles — the RULE METADATA registry (the ESLint-`meta` pattern, adapted).
 *
 * Every deterministic check vigiles ships is DECLARED here with the one fact that
 * dissolves the "why is this a warning / can't this be a type?" confusion: its
 * DECIDABILITY BUCKET, which sets the strongest enforcement the defect can ever
 * reach. See `research/enforcement-model.md` for the full model and
 * `lint-rule-calibration` (root CLAUDE.md) for the governance rule.
 *
 * WHY A CENTRAL REGISTRY, NOT CO-LOCATED `export const meta`. ESLint co-locates
 * meta with each rule because there 1 rule = 1 module. vigiles deliberately
 * SHARES detectors (one-detector-no-drift: a single pure function feeds both
 * `lint` and `audit`, and `scan.ts` computes many rules at once), so co-locating
 * would scatter metas across files that each own several rules — the very
 * fragmentation we're removing. ONE registry keyed by rule name is the honest
 * single source (mirrors `cli-commands.ts` for verbs); the `detector` field names
 * the pure function so traceability survives.
 *
 * The bucket is the CEILING; `defaultSeverity` is where the rule sits TODAY. A
 * gap between them is meaningful: a bucket-A/B rule at `warn` is a CANDIDATE for
 * promotion to `error` (deterministic, just rolling out), whereas a bucket-C rule
 * at `warn` is permanent (forcing it to `error` would cry wolf).
 */
import type { RulesConfig } from "./types.js";

/**
 * The decidability class of a defect — the single fact that sets its ceiling.
 *
 * - `structural-closed` — decidable from the artifact's own content over a CLOSED
 *   vocabulary; a TYPE could make it impossible for authors who route through the
 *   typed constructor. Ceiling: unrepresentable / won't-typecheck.
 * - `external-decidable` — decidable, but needs the EXTERNAL world (the
 *   filesystem, a linter catalog, another file/server). No type can read those,
 *   so the ceiling is a hard ERROR at compile-cross-ref or lint — never a type.
 * - `heuristic-behavioral` — undecidable or a fuzzy proxy ("are these too
 *   similar?", "does this fire?"). Ceiling: a WARNING or a model-MEASUREMENT. By
 *   the math, not by laziness; an `error` here would cry wolf.
 */
export type RuleBucket =
  | "structural-closed"
  | "external-decidable"
  | "heuristic-behavioral";

/** The artifact surface a rule reads (coarse; a rule may span several). */
export type RuleSurface =
  | "instruction"
  | "skill"
  | "subagent"
  | "hook"
  | "output-style"
  | "mcp"
  | "plugin"
  | "docs";

/** Where a rule sits by default — `"off"` is the normalized form of `false`. */
export type RuleDefaultSeverity = "error" | "warn" | "off";

/** Every named rule: the `RulesConfig` keys plus the built-in `orphan-docs`. */
export type RuleName = keyof RulesConfig;

/**
 * The declared shape of one rule — co-located metadata in the ESLint `meta`
 * sense, gathered into one registry because vigiles shares detectors.
 */
export interface RuleMeta {
  /** Canonical rule id (a `RulesConfig` key or `orphan-docs`). */
  readonly id: RuleName;
  /** The decidability class → the rule's strongest possible ceiling. */
  readonly bucket: RuleBucket;
  /** The artifact surface(s) the rule reads (non-empty). */
  readonly surface: readonly RuleSurface[];
  /** Where the rule sits by default today (≤ the bucket's ceiling). */
  readonly defaultSeverity: RuleDefaultSeverity;
  /** One-line "what it checks" (tracks the docs matrix row). */
  readonly summary: string;
  /** The shared pure detector function (one-detector-no-drift traceability). */
  readonly detector: string;
  /**
   * The upstream construct that makes this SAME defect impossible for authors who
   * route through it — a TYPE (structural-closed) or a COMPILE cross-ref. Absent
   * when no construct path exists for the surface, the prevention isn't shipped
   * yet, or the defect is undecidable (heuristic-behavioral). The lint rule is
   * always the artifact-time floor regardless.
   */
  readonly upstreamPrevention?: string;
  /**
   * What fixes a finding: `"edit"` (the user edits their own file), a CLI verb,
   * or a public export. Data, so a test can hold the line that a rule ON by
   * default is never curable only through an `experimental_` export.
   */
  readonly cure: RuleCure;
}

/** What fixes a rule's finding; see {@link RuleMeta.cure}. */
export type RuleCure =
  | "edit"
  | { readonly cli: "compile" | "init" }
  | { readonly export: string };

/**
 * The registry. `Record<RuleName, RuleMeta>` makes completeness a COMPILE-TIME
 * guarantee: add a `RulesConfig` key without a meta here and `tsc` fails. The
 * runtime test additionally binds this to `docs/rules/*.md` (the fs side a type
 * can't see).
 */
export const RULE_META: Record<RuleName, RuleMeta> = {
  // --- Spec & integrity (adoption / artifact-matches-source) ---------------
  "require-instructions-spec": {
    id: "require-instructions-spec",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: { cli: "init" },
    summary: "A .spec.ts exists behind each CLAUDE.md / AGENTS.md.",
    detector: "spec-presence (cli)",
  },
  "require-skill-spec": {
    id: "require-skill-spec",
    bucket: "external-decidable",
    surface: ["skill"],
    defaultSeverity: "off",
    cure: { export: "experimental_skill" },
    summary: "A .spec.ts exists behind each SKILL.md (opt-in).",
    detector: "spec-presence (cli)",
  },
  integrity: {
    id: "integrity",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: { cli: "compile" },
    summary: "A compiled instruction file still matches its spec's SHA-256.",
    detector: "checkIntegrity",
    upstreamPrevention:
      "compile stamps the hash; this catches later hand-edits",
  },
  coverage: {
    id: "coverage",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "off",
    cure: "edit",
    summary: "The spec covers ≥ threshold of linter rules / npm scripts.",
    detector: "analyzeCoverage",
  },

  // --- Test coverage --------------------------------------------------------
  "untested-skill": {
    id: "untested-skill",
    bucket: "external-decidable",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A SKILL.md ships with a test or eval.",
    detector: "findUntestedSurfaces",
  },
  "untested-subagent": {
    id: "untested-subagent",
    bucket: "external-decidable",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent (agents/*.md) ships with a test or eval.",
    detector: "findUntestedSurfaces",
  },
  "untested-hook": {
    id: "untested-hook",
    bucket: "external-decidable",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A file-backed hook script ships with a test or eval.",
    detector: "findUntestedSurfaces",
  },
  "untested-output-style": {
    id: "untested-output-style",
    bucket: "external-decidable",
    surface: ["output-style"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "An output style ships with a test or eval.",
    detector: "findUntestedSurfaces",
  },

  // --- Reference marking ----------------------------------------------------
  "unmarked-refs": {
    id: "unmarked-refs",
    bucket: "heuristic-behavioral",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "Code-shaped refs in an instruction file are marked (verifiable).",
    detector: "collectRefIssues",
  },

  // --- Subagent contracts ---------------------------------------------------
  "subagent-tool-contract": {
    id: "subagent-tool-contract",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent's tools: are all real (no never-available / typo).",
    detector: "verifyToolContract / scoredIssues",
    upstreamPrevention:
      "typed experimental_agent() vocabulary + compileAgent — an unknown tool is a tsc/compile error",
  },
  "disallowed-tools-contract": {
    id: "disallowed-tools-contract",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A disallowedTools: entry isn't a typo that blocks nothing.",
    detector: "disallowedToolIssues",
    upstreamPrevention:
      "typed experimental_agent() vocabulary (a typo is a tsc error)",
  },
  "subagent-frontmatter": {
    id: "subagent-frontmatter",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent has required name/description + valid model/color.",
    detector: "frontmatterIssuesFor",
    upstreamPrevention: "compileAgent emits the required frontmatter",
  },

  // --- Hooks & MCP ----------------------------------------------------------
  "hook-events": {
    id: "hook-events",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A hook's event name is one the harness defines (it can fire).",
    detector: "verifyHookEvents / scoredIssues",
    upstreamPrevention: "compiled hook on: is dialect-validated at compile",
  },
  "hook-script-exists": {
    id: "hook-script-exists",
    bucket: "external-decidable",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: { cli: "compile" },
    summary:
      "A file a compiled hook line needs (runtime, program, stamp) exists.",
    detector: "scanHooks over the hook-line plan (status 'missing')",
    upstreamPrevention:
      "a compiled hook is self-contained (no external script)",
  },
  "hand-written-hook": {
    id: "hand-written-hook",
    bucket: "heuristic-behavioral",
    surface: ["hook"],
    defaultSeverity: "off",
    cure: { export: "experimental_defineHook" },
    summary:
      "A hook line vigiles did not write is named: a static reader cannot verify it, so compile it.",
    detector: "scanHooks (handWritten: no planned line matches)",
    upstreamPrevention: "a compiled hook's line is written by compile itself",
  },
  "hook-block-ineffective": {
    id: "hook-block-ineffective",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A hook that looks like it blocks actually can (event + field).",
    detector: "hookBlockIssues",
    upstreamPrevention:
      "compiled hooks — deny compiles to exit 2; the field/exit code is never hand-written",
  },
  "hook-matcher": {
    id: "hook-matcher",
    bucket: "structural-closed",
    surface: ["hook"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A hook matcher fires as written (no tool-name typo, no MCP pattern that reaches nothing or misses real server names).",
    detector: "hookMatcherIssues",
    upstreamPrevention: "compiled hook tool()/tools() matcher is typed",
  },
  "doc-refs": {
    id: "doc-refs",
    bucket: "external-decidable",
    surface: ["docs"],
    defaultSeverity: "off",
    cure: "edit",
    summary:
      "Builder calls quoted in markdown ```ts fences resolve for real (opt-in: a fence is usually a drawing of config, not config).",
    detector: "findDocRefs",
  },
  "mcp-config": {
    id: "mcp-config",
    bucket: "structural-closed",
    surface: ["mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A declared MCP server can start (has a command or url).",
    detector: "verifyMcpServers",
  },
  "mcp-tool-resolves": {
    id: "mcp-tool-resolves",
    bucket: "external-decidable",
    surface: ["subagent", "mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A subagent's mcp__server__tool names a declared server.",
    detector: "verifyMcpToolServers",
  },
  "mcp-hook-target-resolves": {
    id: "mcp-hook-target-resolves",
    bucket: "external-decidable",
    surface: ["hook", "mcp"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A type:mcp_tool hook action is complete + names a declared server.",
    detector: "verifyMcpHookTargets",
  },

  // --- Skill triggers -------------------------------------------------------
  "skill-frontmatter": {
    id: "skill-frontmatter",
    bucket: "structural-closed",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A SKILL.md declares an explicit name + description (reliable trigger).",
    detector: "skillMetaIssuesFor",
    upstreamPrevention: "skill() compiler emits name + description",
  },
  "skill-missing-fence": {
    id: "skill-missing-fence",
    bucket: "structural-closed",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "A SKILL.md opens with a --- fence (else it loads as inert body).",
    detector: "skillMissingFence",
    upstreamPrevention: "skill() compiler always emits the fence",
  },
  "description-overlap": {
    id: "description-overlap",
    bucket: "heuristic-behavioral",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Two model-invocable skills aren't near-identical (wrong one fires).",
    detector: "findDescriptionOverlaps",
  },
  "instruction-weight": {
    id: "instruction-weight",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "error",
    cure: "edit",
    summary:
      "The always-loaded instruction weight did not move off its committed baseline.",
    detector: "compareToBaseline",
  },
  "compile-budget": {
    id: "compile-budget",
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
  },
  "deprecated-key-files": {
    id: "deprecated-key-files",
    bucket: "structural-closed",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "An instruction spec doesn't use the deprecated keyFiles (always-loaded file map).",
    detector: "findDeprecatedKeyFiles",
    upstreamPrevention: "the @deprecated keyFiles field is removed next major",
  },
  "skill-description-budget": {
    id: "skill-description-budget",
    bucket: "heuristic-behavioral",
    surface: ["skill"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A model-invocable skill's description isn't so long the trigger is buried.",
    detector: "findDescriptionBudgetIssues",
  },
  "frontmatter-valid": {
    id: "frontmatter-valid",
    bucket: "heuristic-behavioral",
    surface: ["skill", "subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "A --- block parses as YAML (js-yaml is stricter than some loaders).",
    detector: "malformedFrontmatterFor",
    upstreamPrevention: "the spec compiler emits valid frontmatter",
  },
  "skill-resource-resolves": {
    id: "skill-resource-resolves",
    bucket: "external-decidable",
    surface: ["skill"],
    // OFF: in the `experimental` group (EXPERIMENTAL_RULES below) — 44% measured
    // precision. See docs/rules/skill-resource-resolves.md.
    defaultSeverity: "off",
    cure: "edit",
    summary: "A SKILL.md's bundled-file reference exists under the skill dir.",
    detector: "skillResourceIssues",
  },

  // --- Plugin layout & safety ----------------------------------------------
  "plugin-dir-layout": {
    id: "plugin-dir-layout",
    bucket: "external-decidable",
    surface: ["plugin"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No functional surface dir is nested inside the manifest dir.",
    detector: "pluginDirLayoutIssues",
    upstreamPrevention: "init scaffolds surfaces at the plugin root",
  },
  "lethal-trifecta": {
    id: "lethal-trifecta",
    bucket: "structural-closed",
    surface: ["skill", "subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No unit's tools hold all three lethal-trifecta legs at once.",
    detector: "lethalTrifectaIssues",
  },
  "delegation-trifecta": {
    id: "delegation-trifecta",
    bucket: "structural-closed",
    surface: ["subagent"],
    defaultSeverity: "warn",
    cure: "edit",
    summary: "No subagent's (own ∪ delegated) capability forms a trifecta.",
    detector: "delegationTrifectaIssues",
  },

  // --- Docs hygiene ---------------------------------------------------------
  "duplicate-rules": {
    id: "duplicate-rules",
    bucket: "heuristic-behavioral",
    surface: ["instruction"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Near-duplicate rules within one spec (NCD similarity) — two rules saying the same thing.",
    detector: "findDuplicateRules",
  },
  "spec-refs": {
    id: "spec-refs",
    bucket: "external-decidable",
    surface: ["instruction"],
    defaultSeverity: "error",
    cure: "edit",
    summary:
      "A compiled instruction file whose spec references a file/script that no longer exists.",
    detector: "compileClaude",
  },
  "orphan-docs": {
    id: "orphan-docs",
    bucket: "heuristic-behavioral",
    surface: ["docs"],
    defaultSeverity: "warn",
    cure: "edit",
    summary:
      "Opt-in: a doc in a configured dir (default docs/) that no other .md references.",
    detector: "findOrphanDocs",
  },
};

/**
 * The **`experimental`** rule GROUP — checks vigiles ships but has not measured
 * as reliable enough to grade anyone on: their MEASURED precision on real public
 * repositories is below the bar a default-on rule must clear. The fourth group
 * beside the three confidence groups (`structural` = `vigiles:recommended`,
 * `workflow` = `init --strict`, `nudge`); one group owns each rule.
 *
 * What membership means, everywhere at once:
 *
 * - OFF by default (`defaultSeverity: "off"`; `rule-meta.test.ts` holds it).
 * - Turned on ONLY when asked: the `vigiles:experimental` preset, from config
 *   (`"extends"`) or for one run (`audit`/`lint --preset=experimental`), sets the
 *   whole group to `warn`; a `rules` entry turns one rule on. Nothing vigiles
 *   writes raises one to `error` — not `init`, not `--strict`.
 * - NEVER in the audit score. The scan keeps the group's findings under
 *   `ScanReport.experimental`, apart from every field a grader reads, so an
 *   experimental finding cannot move a ring, the overall, the grade or the
 *   verdict even when it is shown. When on, `audit` lists it in a separate
 *   "Experimental — not graded" block on every surface.
 *
 * Adding a rule here is one line, plus moving its scan findings under
 * `ScanReport.experimental` — the mapped type there will not compile until
 * every rule in this list has a findings shape, and its old graded field stops
 * existing, so every grader that read it fails to compile too.
 */
export const EXPERIMENTAL_RULES = [
  "skill-resource-resolves",
] as const satisfies readonly RuleName[];

/** A rule in the {@link EXPERIMENTAL_RULES} group. */
export type ExperimentalRuleName = (typeof EXPERIMENTAL_RULES)[number];

/** Whether `id` names a rule in the experimental group. */
export function isExperimentalRule(id: string): id is ExperimentalRuleName {
  return EXPERIMENTAL_RULES.some((r) => r === id);
}

/** All declared rule metas, as a list. */
export function allRuleMeta(): RuleMeta[] {
  return Object.values(RULE_META);
}

/** Look up one rule's meta (undefined for an unknown id). */
export function ruleMeta(id: string): RuleMeta | undefined {
  return (RULE_META as Record<string, RuleMeta | undefined>)[id];
}
