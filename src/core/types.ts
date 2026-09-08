import type { HarnessDialect } from "./dialect.js";

/** A parsed rule from a markdown instruction file. */
export interface ParsedRule {
  title: string;
  line: number;
  enforcement: "enforced" | "guidance" | "disabled" | "missing";
  enforcedBy: string | null;
}

/** A validation error produced by a rule check. */
export interface ValidationError {
  rule: string;
  message: string;
  line: number;
}

/** Result of validating a single file's content. */
export interface ValidationResult {
  rules: ParsedRule[];
  enforced: number;
  guidanceOnly: number;
  disabled: number;
  missing: number;
  total: number;
  errors: ValidationError[];
  warnings: ValidationError[];
  valid: boolean;
}

/** Result of reading a file (may be skipped due to symlinks). */
export interface ReadResult {
  content: string | null;
  skipped: boolean;
  reason: string | null;
}

/** Result of validating a single file path. */
export interface FileResult {
  path: string;
  skipped: boolean;
  reason: string | null;
  result: ValidationResult | null;
}

/** Combined result of validating multiple file paths. */
export interface ValidatePathsResult {
  fileResults: FileResult[];
  valid: boolean;
}

/** Toggleable rule settings. */
/** Rule severity: "warn" prints but exits 0, "error" fails, false disables. */
export type RuleSeverity = "warn" | "error" | false;

/** Rule with options: severity alone or [severity, options] tuple. */
export type RuleWithOptions<T> =
  | RuleSeverity
  | [Exclude<RuleSeverity, false>, T];

/** Options for the coverage rule. */
export interface CoverageThresholds {
  /** Min % of enabled linter rules with enforce() declarations. */
  linterRules?: number;
  /** Min % of npm scripts documented in spec commands. */
  scripts?: number;
}

/**
 * Options for the orphan-docs check. The PRESENCE of this block in
 * `.vigilesrc.json` OPTS THE REPO IN — the scan is off unless declared,
 * because "unreferenced" only means "rot" for a hand-cross-linked corpus,
 * not for a nav-managed doc site (Docusaurus/MkDocs) where the page graph
 * lives in config. `include` is the optional dir override.
 */
export interface OrphansConfig {
  /**
   * Glob patterns of `.md` files to scan for orphans. A doc is "orphaned"
   * when no other markdown file references it. Omitted → `["docs/**\/*.md"]`
   * (the common convention); add your own dirs (e.g. a `research/` notes
   * tree) explicitly. Set to `[]` to opt in but scan nothing.
   */
  include?: readonly string[];
  /**
   * Glob patterns to exclude within the include scope. Same shape as
   * `tsconfig.json#exclude`.
   */
  exclude?: readonly string[];
}

/**
 * Shared options for the per-kind untested-* rules (`untested-skill` /
 * `untested-subagent` / `untested-hook`). Which kinds are scanned is controlled by
 * each rule's severity (set a rule to `false` to skip that kind), so only the
 * test-discovery knobs live here.
 */
export interface TestCoverageConfig {
  /** Globs of test files that count as coverage. */
  include?: readonly string[];
  /** Extra ignore globs. */
  exclude?: readonly string[];
  /**
   * Which extension the SUGGESTED test path in an untested-* finding uses
   * (`<surface>.harness.<ext>`). Detection decides by default — a `tsconfig.json`
   * or a `typescript` dependency means `.ts`, otherwise `.mjs` — and this exists
   * only to disagree with it: a monorepo of mixed packages, a JS project carrying
   * a stray `tsconfig.json`, or a deliberate choice to keep tests in JS. An
   * unrecognised value is ignored rather than honoured, since suggesting
   * `foo.harness.rb` would point the author at a path no runner can execute.
   * Never written by `vigiles init` — see `core/test-file-ext.ts` for why.
   */
  testExtension?: string;
}

export interface RulesConfig {
  /**
   * Opt-in: a doc in a configured dir (default `docs/`) that no other `.md`
   * references. The `orphans` block turns the SCAN on; this turns the FINDING
   * into a warning or an error.
   *
   * It lived outside this interface until 2026-09 and therefore could not be
   * set at all: `"warn"` and `"off"` were both ignored and the check always
   * exited 1, so a repo's only choice was an always-blocking check or deleting
   * the `orphans` block (#181). Default: "error", matching the old behaviour.
   */
  "orphan-docs"?: RuleSeverity;
  /**
   * Re-derive a compiled instruction file's references from its `.spec.ts` and
   * report the dead ones.
   *
   * The integrity hash answers "is this file still what the spec compiled to";
   * it says nothing about whether the paths and scripts it NAMES still exist. So
   * an artifact committed while its refs were live stayed green forever after
   * the target was deleted — `compile` errored, `lint` said "hash valid" and
   * exited 0 (#173). Default: "error", matching `compile`.
   */
  "spec-refs"?: RuleSeverity;
  /**
   * Near-duplicate rules WITHIN one spec, by NCD similarity — spec bloat, two
   * rules saying the same thing in different words.
   *
   * Also previously untierable, and worse: it had no rule id at all, so there
   * was no name a config could even mention (#181). Default: "error".
   */
  "duplicate-rules"?: RuleSeverity;
  /**
   * Require a `.spec.ts` behind each instruction file (CLAUDE.md / AGENTS.md) —
   * the file must be compiled from a typed spec, not hand-written. NARROW: only a
   * `.spec.ts` sibling (or an explicit `<!-- vigiles-disable
   * require-instructions-spec -->` marker) satisfies it; inline
   * `<!-- vigiles:enforce -->` comments do NOT (the rule name says "spec"). Default:
   * "warn". `vigiles init` auto-adopts every instruction file into a spec, so this
   * is GREEN by construction after setup — a safety net for a NEW hand-added file,
   * not a nag. The workflow-tier opt-in (gated under `--strict`).
   */
  "require-instructions-spec"?: RuleSeverity;
  /**
   * Require a `.spec.ts` behind each SKILL.md — the consistent
   * `require-<surface>-spec` parallel to `require-instructions-spec`. Default:
   * false (OFF): skills are legitimately hand-written, and the coverage that
   * matters ("every skill ships with a test/eval") is the `untested-skill` rule.
   * Set it explicitly if your team wants every skill spec-managed.
   */
  "require-skill-spec"?: RuleSeverity;
  /** Detect hand-edits to compiled markdown via SHA-256 hash. Default: "warn". */
  integrity?: RuleSeverity;
  /** Enforce minimum spec coverage thresholds. Default: false. ESLint-style: ["warn", { scripts: 50 }]. */
  coverage?: RuleWithOptions<CoverageThresholds>;
  /** Flag a skill (SKILL.md) that ships with no test or eval. Default: "warn". */
  "untested-skill"?: RuleWithOptions<TestCoverageConfig>;
  /** Flag a subagent (agents/*.md) that ships with no test or eval. Default: "warn". */
  "untested-subagent"?: RuleWithOptions<TestCoverageConfig>;
  /** Flag a hook script that ships with no test or eval. Default: "warn". */
  "untested-hook"?: RuleWithOptions<TestCoverageConfig>;
  /**
   * Nudge (or block) when an instruction file has code-shaped references that
   * aren't expressed as vigiles marks (so the lint can't verify them), or a
   * `vigiles:symbol` mark that points at a missing symbol. Drives the
   * PostToolUse refs-hook: "warn" (default) → a non-blocking nudge, "error" →
   * block the edit, false → off.
   */
  "unmarked-refs"?: RuleSeverity;
  /**
   * Cross-reference each subagent's `tools:` rail against the harness tool
   * catalog — flag a never-available tool or a close typo (the moat). Only
   * high-confidence issues are reported (a bare unrecognized tool is likely
   * plugin/MCP-provided, never flagged). Off unless set; "warn" surfaces,
   * "error" gates CI. Same detector as `scan` + `compileAgent`.
   */
  "subagent-tool-contract"?: RuleSeverity;
  /**
   * Flag a hook registered under an event name the harness doesn't define (a
   * typo → the hook never fires). High-precision: close typos only, never a
   * framework/custom event. Default "warn"; "error" gates CI. Same detector as
   * `scan`.
   */
  "hook-events"?: RuleSeverity;
  /**
   * Flag a skill/agent missing a required frontmatter field — a skill needs
   * `name` (to load), an agent needs `name` + `description`. A broken surface
   * that won't register. Default "warn"; "error" gates CI. Same detector as `scan`.
   */
  "subagent-frontmatter"?: RuleSeverity;
  /**
   * Flag a declared MCP server that can't start — neither a `command` (stdio)
   * nor a `url` (http/sse). Default "warn"; "error" gates CI. Same detector as
   * `scan`. (JSON `.mcp.json`/manifest `mcpServers`; Codex TOML not yet parsed.)
   */
  "mcp-config"?: RuleSeverity;
  /**
   * RECOMMEND (not require) that a SKILL.md declares an explicit `name` +
   * `description` rather than relying on the dir-name / first-paragraph
   * fallbacks — a more reliable trigger surface. The skill still loads without
   * them, so this is a best-practice nudge: default "warn"; set "error" to
   * enforce on your own skills. Same detector as `scan` (skillMetaIssues).
   */
  "skill-frontmatter"?: RuleSeverity;
  /**
   * Cross-reference an `mcp__server__tool` in a subagent's contract against the
   * plugin's declared `mcpServers` — flag a server the plugin doesn't declare
   * (the MCP half of the tool moat; `subagent-tool-contract` checks the built-in
   * half). High-precision: only flags when the plugin SHIPS a declared set,
   * allowlists harness built-ins (`ide`), and skips the plugin-namespaced
   * `mcp__plugin_…` form. Default "warn"; "error" gates CI. Same detector as
   * `scan` (mcpToolIssues).
   */
  "mcp-tool-resolves"?: RuleSeverity;
  /**
   * Flag a hook command that references a script file which doesn't exist on
   * disk (with `${CLAUDE_PLUGIN_ROOT}` resolved) — the hook silently never runs.
   * FP-safe: skips unresolved `$VAR` paths, existence-guarded one-liners, and
   * inline commands. NOT covered by Anthropic's `claude plugin validate` — the
   * "matches" claim here was measured false on 2026-09-08 (Claude Code 2.1.263;
   * see docs/rules/hook-script-exists.md). Default
   * "warn"; "error" gates CI. Same detector as `scan` (hooks status "missing").
   */
  "hook-script-exists"?: RuleSeverity;
  /**
   * A single repo-level RECOMMENDATION (one finding regardless of hook count):
   * when a plugin/repo ships hand-written hook commands that aren't compiled
   * `vigiles/hook` artifacts, nudge toward compiled hooks — they make whole hook
   * bug classes (exit-1-not-2, wrong decision field, matcher bypass) UNREPRESENTABLE
   * at authoring time, and `guardrail-check` proves an existing one blocks. A
   * discovery nudge, not a defect: the hand-written shell lane stays first-class,
   * so it's opt-out and fires ONCE (never per-hook). The message links
   * `docs/compiled-hooks.md`. Default "warn"; set "off" to silence or "error" to
   * enforce. Same detector as `scan` (manualHookCount).
   */
  "prefer-compiled-hooks"?: RuleSeverity;
  /**
   * Cross-reference a subagent's `disallowedTools:` block-list against the
   * catalog — the deny-side mirror of `subagent-tool-contract`. A close typo there
   * blocks NOTHING (you meant to deny `Bash`, wrote `Bsh`), leaving the tool
   * available. High-precision: close-typo only (a never-available tool is
   * harmless to list, a bare unknown is likely a plugin tool). Default "warn";
   * "error" gates CI. Same detector as `scan` (disallowedToolIssues).
   */
  "disallowed-tools-contract"?: RuleSeverity;
  /**
   * Flag two model-invocable skills whose descriptions are near-identical — the
   * selector can't tell them apart, so the wrong one fires (a precision
   * collision). A DETERMINISTIC NCD proxy for a `--trigger`-class behavioral bug;
   * calibrated FP-safe (only basically-identical text, below the sweep's
   * most-similar distinct pair). Default "warn"; "error" gates CI. Same detector
   * as `scan` (descriptionOverlaps).
   */
  "description-overlap"?: RuleSeverity;
  /**
   * Flag a model-invocable skill whose `description` is so long the trigger
   * signal is buried — the selector weighs the opening most, so a bloated
   * description hurts recall + precision. A DETERMINISTIC heuristic proxy for a
   * `--trigger`-class behavioral bug; calibrated FP-safe (generous default
   * budget, 500 chars). Default "warn" — a proxy, never gates. Same detector as
   * `scan` (descriptionBudgetIssues).
   */
  "skill-description-budget"?: RuleSeverity;
  /**
   * Flag a skill/agent whose `---` frontmatter block EXISTS but isn't valid YAML
   * — fields may not parse as intended. CAVEAT: a real YAML parser (js-yaml) is
   * stricter than some loaders, so a one-line `description:` containing a `: `
   * colon or an `<example>` block is flagged even though it may still load.
   * Hence default "warn" (a nudge), not "error" — verify before enforcing. Same
   * detector as `scan` (malformedFrontmatter).
   */
  "frontmatter-valid"?: RuleSeverity;
  /**
   * Flag a `type: "mcp_tool"` hook action that's incomplete (missing `server` /
   * `tool`) or targets a server the plugin doesn't declare in `mcpServers` — the
   * hook silently never dispatches. High-precision: the undeclared-server half is
   * gated on the plugin shipping a declared set and allowlists built-ins (`ide`),
   * mirroring `mcp-tool-resolves`. Default "warn"; "error" gates CI. Same detector
   * as `scan` (mcpHookIssues).
   */
  "mcp-hook-target-resolves"?: RuleSeverity;
  /**
   * Flag a unit (subagent / model-invocable skill) whose declared tools hold all
   * THREE legs of Simon Willison's "lethal trifecta" — read private data, ingest
   * untrusted content, AND exfiltrate — a prompt-injection exfil path with no
   * exploit code (Meta's Rule of Two: allow at most two). A capability SET-
   * intersection over the declared contract, NOT a text scan; high-precision (only
   * well-known tools map to a leg). An EXPLICIT all-three contract is a "hard"
   * finding; an inherits-all unit (no contract → every leg) is "advisory". Default
   * "warn" (don't-cry-wolf rollout); raise to "error" to gate CI. Same detector as
   * `scan` (lethalTrifectaIssues). See docs/rules/lethal-trifecta.md.
   */
  "lethal-trifecta"?: RuleSeverity;
  /**
   * Flag a SKILL.md body referencing a bundled file (`scripts/`/`references/`/
   * `assets/`, or a relative markdown link with an extension) that doesn't exist
   * on disk under the skill dir — the agent reads the instruction, gets nothing,
   * and silently continues. The cross-reference moat applied to the SKILL.md body.
   * High-precision / FP-safe (skips URLs, `$VAR` tokens, `../` escapes, extension-
   * less mentions). Default "warn"; raise to "error" to gate CI. Same detector as
   * `scan` (skillResourceIssues). See docs/rules/skill-resource-resolves.md.
   */
  "skill-resource-resolves"?: RuleSeverity;
  /**
   * Flag a SKILL.md that opens with frontmatter-looking keys (`name:`,
   * `description:`, …) but has NO opening `---` fence — the harness loads the
   * whole file as body, so the skill has no name/description/trigger and is
   * invisible (never fires). High-precision (a fixed key whitelist; markdown /
   * prose lines never match). Default "warn"; raise to "error" to gate CI. Same
   * detector as `scan` (skillFenceIssues). See docs/rules/skill-missing-fence.md.
   */
  "skill-missing-fence"?: RuleSeverity;
  /**
   * Flag a functional surface directory (skills/agents/commands) nested INSIDE
   * the `.claude-plugin/` manifest dir, where only `plugin.json` belongs — the
   * harness can't see it, so the surface is invisible (the #1 plugin-author
   * mistake). Pure filesystem check, FP-safe. Default "warn"; raise to "error"
   * to gate CI. Same detector as `scan` (pluginLayoutIssues). See
   * docs/rules/plugin-dir-layout.md.
   */
  "plugin-dir-layout"?: RuleSeverity;
  /**
   * Flag a lethal trifecta that EMERGES across a delegation edge — a subagent
   * whose effective (own ∪ delegated-to) capability holds all three legs though
   * no single unit does (the combined blast radius). The capability-diff across
   * the delegation tree; skips units the per-unit `lethal-trifecta` already
   * flags (no double-report), FP-safe (explicit edges, wildcard-guarded). Default
   * "warn"; raise to "error" to gate CI. Same detector as `scan`
   * (delegationTrifecta). See docs/rules/delegation-trifecta.md.
   */
  "delegation-trifecta"?: RuleSeverity;
  /**
   * Flag a hook that LOOKS like it blocks but silently doesn't — a block decision
   * (`exit 2` / `decision` / `permissionDecision`) on an event that can't veto, or
   * the legacy top-level `decision` field on a permission-gated event where only
   * `hookSpecificOutput.permissionDecision` works (#19009, the #1 verified hook
   * pain). FP-safe (conservative literal patterns; the blocking-event sets are
   * read from the dialect, so it runs only where they're declared). Default "warn";
   * raise to "error" to gate CI. Same detector as `scan` (hookBlockFindings). See
   * docs/rules/hook-block-ineffective.md.
   */
  "hook-block-ineffective"?: RuleSeverity;
  /**
   * Flag a hook `matcher` string that doesn't fire the way it reads — a close
   * typo of a built-in tool (`bash`→`Bash`), a matcher that doesn't COMPILE, an
   * MCP pattern that can match no tool name at all (`mcp_memory_*` instead of
   * `mcp__memory__.*`), an MCP pattern too narrow for real server naming
   * (`mcp__[^_]+__[^_]+` can't cross the `_` in `mcp__Google_Calendar__…`), or a
   * server the plugin doesn't declare. A matcher is a PATTERN, so patterns are
   * validated by compiling and probing, never by literal shape. High-precision
   * (close-typo only; MCP gated on a declared set, built-ins allowlisted;
   * match-all and alternation skipped). Default "warn"; raise to "error" to gate
   * CI. Same detector as `scan` (hookMatcherFindings). See
   * docs/rules/hook-matcher.md.
   */
  "hook-matcher"?: RuleSeverity;
  /**
   * Validate vigiles-builder calls quoted inside ```ts fences in markdown —
   * `enforce()` / `file()` / `cmd()` / `ref()` — against the real linter catalog,
   * filesystem and package scripts.
   *
   * DEFAULT OFF, and the default is the finding. Measured on two repositories
   * 2026-08-19 (2 582 markdown files, 52 refs): **zero true positives, and every
   * error it has ever raised was a false one** — a design sketch writing
   * `cmd("npm test")` for a package that doesn't exist yet, or a third-party
   * `CLAUDE.md` captured verbatim as benchmark data. The reason is structural,
   * not calibration: a fenced block in prose is a DRAWING of config, and this
   * rule reads it as config. The consumer repo could only reach a clean `lint`
   * by excluding a third of itself, after which the pass scanned 604 files and
   * found 0 refs — inert, and still paying for the walk.
   *
   * Turn it on where markdown really is the source (a docs site whose fences are
   * copy-pasted into live specs). See docs/rules/doc-refs.md.
   */
  "doc-refs"?: RuleSeverity;
}

// ---------------------------------------------------------------------------
// Rule parsing helpers
// ---------------------------------------------------------------------------

/** Extract severity from a rule value (handles both simple and tuple forms). */
export function ruleSeverity<T>(
  rule: RuleWithOptions<T> | undefined,
): RuleSeverity {
  if (rule === undefined) return false;
  if (Array.isArray(rule)) return rule[0];
  return rule;
}

/** Extract options from a rule value (returns undefined for simple severity). */
export function ruleOptions<T>(
  rule: RuleWithOptions<T> | undefined,
): T | undefined {
  if (Array.isArray(rule)) return rule[1];
  return undefined;
}

/** Full vigiles configuration. Loaded from .vigilesrc.json. */
export interface VigilesConfig {
  // --- Validation ---
  ruleMarkers: MarkerType[];
  rules: Required<RulesConfig>;
  files: string[];

  // --- Compilation ---
  /** Maximum number of rules allowed per spec. */
  maxRules?: number;
  /** Maximum estimated tokens for compiled output. */
  maxTokens?: number;
  /** Maximum lines per prose section. */
  maxSectionLines?: number;
  /** Skip config-enabled checks, only verify rule exists in catalog. */
  catalogOnly?: boolean;
  /** Custom linter configs (rulesDir). */
  linters?: Record<string, { rulesDir?: string | string[] }>;
  /** Orphan-docs check configuration. Include/exclude globs, tsconfig-style. */
  /**
   * Which bundles `lint` scores: `"root"` (default) or `"all"`.
   *
   * A monorepo holding `skills/` plus `plugins/  * /skills/` had its nested skills
   * silently uncounted — the counters looked complete while whole surfaces were
   * never read (#185). `"all"` scores every discovered bundle in one pass, so a
   * CI gate keeps ONE exit code over the whole repo.
   *
   * Root-only remains the default because descending unconditionally would score
   * vendored third-party plugins (a repo may keep a pinned corpus on disk) as if
   * they were the project's own. The default no longer hides the skip: `lint`
   * names the bundles it did not score.
   */
  bundles?: "root" | "all";
  orphans?: OrphansConfig;
  /**
   * Paths and globs the repo's own tooling does NOT police — vendored corpora,
   * benchmark fixtures, frozen reproductions (tsconfig-style, relative to the
   * repo root; a bare directory name such as `"bench"` excludes its subtree, as
   * do `"bench/"` and `"bench/**"`). `node_modules`/`dist`/`.git`/`.vigiles` are
   * always excluded.
   *
   * ONE filter, every pass (#192): `compile` does not load an excluded spec,
   * `lint` does not discover an excluded instruction file, nested bundle, doc, or
   * surface, `audit` does not read an excluded instruction file, and
   * `test`/`eval` do not discover an excluded script. It filters DISCOVERY only:
   * a path you name on the command line is still processed, and one line says
   * which pattern it matched. The rule-level `orphans.exclude` and
   * `untested-*` `exclude` NARROW their own rule further and never re-admit a
   * path excluded here (union, not override). Parsed once in `src/exclude.ts`.
   */
  exclude?: readonly string[];
  /**
   * Top-level dir names shared across skills, e.g. `["scripts", "references"]`.
   * OPT-IN: many skill libraries keep ONE top-level `scripts/`/`references/` tree
   * rather than a copy beside every `SKILL.md`, so a bundled ref like
   * `scripts/promptfoo/x.py` lives at the REPO ROOT. When a `SKILL.md` body ref's
   * first path segment is a declared shared dir, `skill-resource-resolves` / audit
   * ALSO resolves it against the repo root, not only the skill's own dir. Scoped
   * to declared dirs on purpose: a repo that omits this key behaves exactly as
   * before (skill-dir-only resolution), and a ref outside a shared dir is never
   * masked by a same-named repo-root file. See feedback P1-4.
   */
  sharedDirs?: readonly string[];
  /**
   * The harness(es) this repo targets — selects the compile dialect / skill
   * frontmatter profile / instruction-file shape, instead of sniffing the cwd.
   * A single name (`"codex"`) for the common single-harness repo, or an array
   * (`["claude-code", "codex"]`) declaring the supported set. Written by
   * `vigiles init`. Omitted → the CLI auto-detects (backwards-compatible).
   * Canonical adapter names; `"claude"` is accepted as an alias for
   * `"claude-code"`. See research/multi-harness-compile.md.
   */
  harness?: string | string[];

  /**
   * `vigiles audit` preferences. `measure` is the sticky remembered answer to the
   * "run the executing checks against your harness?" prompt — at a TTY `audit`
   * asks once, then records the choice here so it never asks again. `true` runs
   * the executing checks (safety battery · live MCP · skill firing) on every
   * interactive run, `false` keeps them off (edit this key to change). Written by
   * the audit consent prompt, not `init`. Headless runs never execute regardless
   * (audit is a local report, not a CI step — there is no execution flag).
   */
  audit?: { measure?: boolean };

  /**
   * `vigiles eval` preferences. `apiVersion` is the hand-bumped **behavior epoch**
   * folded into the eval LOCK's input hash (`src/eval-lock.ts`): bump it when a
   * harness-side change YOU made (a CLAUDE.md edit, a global hook) would shift
   * eval outputs but isn't otherwise visible to the lock — so `vigiles eval
   * --check` reports the committed eval results STALE and forces a local re-run.
   * Default 1. Distinct from the (auto-resolved) `claude` CLI version, which is
   * recorded as provenance but deliberately NOT hashed.
   */
  eval?: { apiVersion?: number };

  /**
   * Suppress the adoption nudges `audit` prints (the "N surfaces not yet
   * spec-managed → create specs" invitation). Set `"dismissed"` to hide them —
   * the "remembered decline" half of the non-evil adoption contract, so a team
   * that deliberately runs the integrity GATE alone (no specs/plugin) isn't
   * nagged on every run. USER-SET only: `audit`/`lint` are pure reads and never
   * write this (a read never writes). The deterministic findings + fixes are
   * unaffected — this silences only the invitation, never a real finding.
   */
  nudge?: "dismissed";
}

/** Valid marker types for rule detection. */
export type MarkerType = "headings" | "checkboxes";

/** Options for parseRules. */
export interface ParseOptions {
  ruleMarkers?: MarkerType[];
}

/** Options for validate(). */
export interface ValidateOptions {
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
  filePath?: string;
  /** Injected harness dialect; its instructionTargets define recognized
   *  instruction filenames. Omitted → the validator's built-in default set. */
  dialect?: HarnessDialect;
}

/** Options for validatePaths(). */
export interface ValidatePathsOptions {
  followSymlinks?: boolean;
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
}

/** Options for readInstructionFile(). */
export interface ReadOptions {
  followSymlinks?: boolean;
}
