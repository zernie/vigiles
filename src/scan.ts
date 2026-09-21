/**
 * `vigiles audit <dir>` — point vigiles at any plugin/repo and see what it ships
 * and what's broken, with **no model and no API key**.
 *
 * This is the deterministic substrate under the plugin/skill leaderboard
 * (research/divergent-bets.md #9) and the harness-aware scan
 * (research/agent-supply-chain-security.md #1): it re-aims the machinery that
 * already exists — `loadPlugin` (surfaces + dangling-ref/MCP/empty-machine
 * warnings), `parseAgentTools` (the declared tool contract), and
 * `findUntestedSurfaces` — into one read-only report. Behavioral checks that
 * need to RUN the plugin (observed egress under the sandbox, real trigger-rate)
 * stack on top later; this core stays pure so it runs anywhere in CI for free.
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// The COMPOSITION-ROOT loader, not the `vigiles/claude-code` wrapper: this
// module always passes a layout explicitly (it never wanted the wrapper's
// Claude Code default), and only the generic one takes the `ExcludeSet` that
// makes `.vigilesrc.json#exclude` reach surface discovery.
import { loadPlugin } from "./plugin-loader.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";
import { danglingRefs } from "./plugin-loader.js";
import { isEmptyMachine } from "./score-core.js";
import { brokenSkillRefs, formatSkillRefIssue } from "./skill-refs.js";
import type { PluginLayout } from "./core/layout.js";
import type { ExcludeSet } from "./exclude.js";
import type { HarnessDialect } from "./core/dialect.js";
import type { ToolIssue } from "./core/tool-contract.js";
import {
  verifyHookEvents,
  scoredIssues,
  type HookEventIssue,
} from "./core/hook-events.js";
import { verifyMcpServers, type McpIssue } from "./core/mcp-config.js";
import { agentPluginsMcpSources } from "./core/agent-plugins.js";
import { normalizeHooks, hookEventNames } from "./core/hook-normalize.js";
import type { DescriptionOverlap } from "./core/description-overlap.js";
import type { DescriptionBudgetIssue } from "./core/skill-description-budget.js";
import type { McpToolIssue } from "./core/mcp-tool.js";
import { verifyMcpContractTools, type McpServerConfig } from "./core/mcp.js";
import {
  mcpContractToolMessage,
  type McpContractToolError,
} from "./core/mcp-contract-message.js";
import { verifyMcpHookTargets, type McpHookIssue } from "./core/mcp-hook.js";
import {
  conflictedHarnessConfigs,
  mergeConflictWarning,
} from "./core/merge-conflict.js";
import type { TrifectaFinding } from "./core/lethal-trifecta.js";
import type { SkillResourceFinding } from "./core/skill-resources.js";
import type { SkillFenceFinding } from "./core/skill-missing-fence.js";
import {
  pluginDirLayoutIssues,
  type PluginLayoutFinding,
} from "./core/plugin-dir-layout.js";
import {
  unclaimedSurfaceFindings,
  type UnclaimedSurfaceFinding,
} from "./core/surface-discovery.js";
import { boundedSurfacePaths } from "./surface-discovery-fs.js";
import { normalizeSurfaceRoots } from "./core/surface-scopes.js";
import { REGISTERED_LAYOUTS } from "./layout-registry.js";
import type { DelegationTrifectaFinding } from "./core/delegation-trifecta.js";
import {
  hookBlockIssues,
  type HookBlockFinding,
} from "./core/hook-block-ineffective.js";
import {
  hookMatcherIssues,
  type HookMatcherFinding,
} from "./core/hook-matcher.js";
import {
  coverageCaveats,
  coverageEvidenceCounts,
  findUntestedSurfaces,
} from "./test-coverage.js";
import { formatEvidence, type EvidenceCounts } from "./coverage-evidence.js";
import type { PurityLevel, EffectSurface } from "./core/effects.js";
import {
  makeClassifier,
  scanAgents,
  scanSkills,
  skillRefSources,
  scanHooks,
  frontmatterIssuesFor,
  frontmatterValueIssuesFor,
  skillMetaIssuesFor,
  malformedFrontmatterFor,
  descriptionOverlapsFor,
  descriptionBudgetFor,
  collectSurfaceFindings,
  collectDelegationTrifecta,
  collectHookBlockEntries,
  collectHookMatchers,
  summarizePurity,
  preferCompiledHooksMessage,
  detectOwnTestSignal,
  remapFindingPaths,
  collectVocabularyNotes,
} from "./scan-core.js";
import {
  weighInstructions,
  type InstructionBudget,
  type InstructionWeight,
} from "./core/instruction-weight.js";
import {
  blockIneffectiveEventsOf,
  permissionDecisionEventsOf,
} from "./core/event-capability.js";

// Re-export the pure detectors (and their public types: SurfaceClassifier,
// SkillScanContext, isManagedHookCommand, preferCompiledHooksMessage, ...) that
// moved to the node-free `./scan-core.js`, so every existing consumer of
// `./scan.js` is unchanged — one detector, no drift.
export * from "./scan-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanSkill {
  readonly name: string;
  readonly path: string;
  readonly hasDescription: boolean;
  /**
   * The skill's effective description (frontmatter `description`, else the first
   * body paragraph — the same text the selector keys on), trimmed; `undefined`
   * when neither exists. Feeds the model trigger tier's auto-generated probes.
   */
  readonly description?: string;
  readonly userInvoked: boolean;
  /**
   * SKILL.md body references to a bundled file (`scripts/`/`references/`/`assets/`
   * or a relative markdown link with an extension) that don't resolve on disk
   * under the skill dir — the agent reads the instruction and gets nothing.
   * Computed by `skillResourceIssues()` (one detector, no drift).
   */
  readonly resourceIssues: readonly SkillResourceFinding[];
  /**
   * Lethal-trifecta finding when a MODEL-INVOCABLE skill's `disallowed-tools:`
   * fence leaves all three legs standing (read-private + ingest-untrusted +
   * exfiltrate), else null. Computed by `skillTrifectaIssue()` — NOT from
   * `allowed-tools:`, which is a pre-approval and bounds nothing (measured
   * 2026-08-11; see `src/core/lethal-trifecta.ts`). The `fence` field on the
   * finding says whether the skill declared no fence at all (`"none"` — the
   * ecosystem default, aggregated in the report) or a fence that closes no leg
   * (`"ineffective"` — per-skill). A user-invoked skill is excluded (it can't be
   * selected by attacker content).
   */
  readonly trifecta: TrifectaFinding | null;
  /**
   * Set when the SKILL.md opens with frontmatter-looking keys (`name:`, …) but
   * has NO opening `---` fence, so the whole file loads as body — no name, no
   * description, no trigger (the skill is invisible). Computed by
   * `skillMissingFence()` (one detector, no drift).
   */
  readonly fenceIssue: SkillFenceFinding | null;
}

export interface ScanAgent {
  readonly name: string;
  readonly path: string;
  /** Declared tool contract, or null when the agent ships no `tools:` (inherits all). */
  readonly tools: readonly string[] | null;
  /** Contract entries that don't resolve to a real built-in / MCP tool (typo, never-available). */
  readonly toolIssues: readonly ToolIssue[];
  /** MCP tool entries naming a server the plugin doesn't declare (can't resolve). */
  readonly mcpToolIssues: readonly McpToolIssue[];
  /**
   * ADVISORY tool findings — a real tool withheld only under a condition vigiles
   * cannot see, or a name not in its capture. Surfaced via `vocabularyNotes`,
   * never scored. Optional: absence is not a claim of zero.
   */
  readonly toolNotes?: readonly ToolIssue[];
  /** `disallowedTools:` block-list entries that are typos of a real tool (block nothing). */
  readonly disallowedToolIssues: readonly ToolIssue[];
  /**
   * Static effect-surface purity of the agent's declared tool contract.
   * - `"pure"` — no side-effecting tools (read-only, deterministically testable).
   * - `"bounded"` — has side-effecting tools (Edit/Write/…) but no Bash or unknown.
   * - `"unrestricted"` — has Bash, any MCP/unknown tool, or inherits-all (no contract).
   * Computed by `effectSurface()` from `src/core/effects.ts` — one detector, no drift.
   */
  readonly purity: PurityLevel;
  /**
   * The three tool buckets from `effectSurface()`: read-only, side-effecting, and
   * unknown-effect (MCP or unrecognized) tool names in the declared contract.
   */
  readonly effectBuckets: Pick<
    EffectSurface,
    "readOnly" | "sideEffecting" | "unknown"
  >;
  /**
   * Lethal-trifecta finding when the subagent's declared tools hold all three legs
   * (read-private + ingest-untrusted + exfiltrate), else null. An inherits-all
   * agent (no `tools:` line) is the "advisory" case. Computed by
   * `lethalTrifectaIssues()` (one detector, no drift).
   */
  readonly trifecta: TrifectaFinding | null;
}

/** A lethal-trifecta finding tagged with the surface (subagent/skill) that holds it. */
/** One advisory vocabulary finding, tagged with the surface that carries it. */
export interface VocabularyNote {
  /** Where it was found — a hook event key, or an agent's path. */
  readonly where: string;
  readonly message: string;
}

export interface ScanTrifectaFinding {
  readonly path: string;
  readonly kind: "subagent" | "skill";
  readonly name: string;
  readonly finding: TrifectaFinding;
}

/** A SKILL.md body resource reference that doesn't resolve, tagged with the skill path. */
export interface ScanSkillResourceFinding {
  readonly path: string;
  readonly name: string;
  readonly finding: SkillResourceFinding;
}

/** A missing-frontmatter-fence finding tagged with the skill path. */
export interface ScanSkillFenceFinding {
  readonly path: string;
  readonly name: string;
  readonly finding: SkillFenceFinding;
}

/** A delegation-trifecta finding tagged with the subagent path that holds it. */
export interface ScanDelegationFinding {
  readonly path: string;
  readonly finding: DelegationTrifectaFinding;
}

/** A skill/agent whose frontmatter is missing a required field (name / description). */
export interface FrontmatterIssue {
  readonly path: string;
  readonly kind: "skill" | "agent";
  readonly missing: readonly ("name" | "description")[];
  readonly message: string;
}

/** A skill/agent whose `---` block exists but isn't valid YAML (may not parse as intended). */
export interface FrontmatterParseIssue {
  readonly path: string;
  readonly message: string;
}

/** An agent frontmatter field whose VALUE is invalid (a typo of a real model/color). */
export interface FrontmatterValueIssue {
  readonly path: string;
  readonly field: "model" | "color";
  readonly value: string;
  readonly suggestion: string;
  readonly message: string;
}

/** ok = file present; missing = referenced but absent; unresolved = path still has an unexpanded var, can't check. */
export type HookStatus = "ok" | "missing" | "unresolved";

export interface ScanHook {
  /**
   * The full hook command as it would be run (plugin-root token expanded, shell
   * quotes stripped). Present on script-based hooks; empty string on hooks whose
   * command is entirely inline (no script file) — but inline hooks never appear
   * in `hooks[]`, they are counted by `inlineHooks`, so in practice `command` is
   * always non-empty when a `ScanHook` is in the list.
   */
  readonly command: string;
  readonly script: string;
  readonly status: HookStatus;
  /**
   * The hook EVENT this script is registered under (`PreToolUse`, `PostToolUse`,
   * `SessionStart`, …), when it can be determined from the canonical
   * object-keyed-by-event settings shape; `undefined` for a non-object/array
   * config. The safety battery uses it to test only the blocking-capable
   * `PreToolUse` guards — so a `SessionStart`/`PostToolUse` hook isn't unfairly
   * scored against "does it block rm -rf".
   */
  readonly event?: string;
}

/**
 * The repo's top-level instruction file (`CLAUDE.md` / `AGENTS.md`), if present.
 * Every cc/codex repo has one even when it ships no plugin surface, so `scan`
 * reports it — otherwise a plain instruction-only repo looks empty. `hasSpec` is
 * the deterministic fact that a `<file>.spec.ts` sits beside it (spec-managed vs
 * hand-written); it is informational, NOT the `require-instructions-spec` gate (that's lint).
 */
export interface ScanInstructions {
  readonly file: string;
  readonly hasSpec: boolean;
}

export interface ScanReport {
  readonly dir: string;
  /** The detected instruction file (CLAUDE.md/AGENTS.md), or null if none. */
  readonly instructions: ScanInstructions | null;
  readonly skills: readonly ScanSkill[];
  readonly agents: readonly ScanAgent[];
  readonly hooks: readonly ScanHook[];
  /** Hook entries with no script file (inline shell one-liners) — can't be path-checked. */
  readonly inlineHooks: number;
  /**
   * Hand-written hook commands that are NOT compiled `vigiles/hook` artifacts (a
   * compiled hook's command invokes `vigiles hook-runtime run-program`). The basis
   * for the `prefer-compiled-hooks` recommendation — a single nudge regardless of
   * count. Zero when there are no hooks or every hook is vigiles-managed.
   */
  readonly manualHookCount: number;
  readonly commands: number;
  readonly mcp: boolean;
  /**
   * Intra-plugin file references (hook scripts, skill bodies) pointing at files
   * that don't exist on disk — the broken-path / partial-vendor class. A
   * first-class structural finding, not just a free-text warning, so the verdict
   * and the leaderboard can count it.
   */
  readonly danglingRefs: readonly string[];
  /**
   * Skills naming a sibling skill that does not exist (a near-miss of a real one
   * — a rename or a typo). Separate from `danglingRefs` because that field holds
   * PATH tokens from executable sources; these are full sentences about prose.
   * Both are broken intra-plugin references and score in the same category.
   *
   * OPTIONAL because absence is not a claim: a producer that predates this field
   * (or a browser scan that has not been taught it) reports nothing rather than
   * reporting zero, the same `undefined`-vs-`[]` distinction the check counter
   * and `assertNoWrite` already draw.
   */
  readonly skillRefIssues?: readonly string[];
  /** Hooks registered under an event name the harness doesn't define (typo / dead). */
  readonly hookEventIssues: readonly HookEventIssue[];
  /**
   * ADVISORY vocabulary findings — names vigiles could not confirm, and real
   * names the platform withholds only under a condition it cannot see. Surfaced
   * and NEVER scored, which is the point: the two failure modes this replaced
   * were silence (which reads as approval and hides vigiles's own staleness) and
   * an error (which blames the user for our gap). Neither is a verdict, so these
   * get a third channel instead of a grade.
   *
   * OPTIONAL because absence is not a claim: a producer predating this field
   * reports nothing rather than reporting zero.
   */
  readonly vocabularyNotes?: readonly VocabularyNote[];
  /** Skills/agents missing a required frontmatter field (name; agents also description). */
  readonly frontmatterIssues: readonly FrontmatterIssue[];
  /** Agent frontmatter fields with an invalid value (a typo of a real model/color). */
  readonly frontmatterValueIssues: readonly FrontmatterValueIssue[];
  /** Skills lacking an EXPLICIT name/description — a best-practice recommendation, not a defect. */
  readonly skillMetaIssues: readonly FrontmatterIssue[];
  /** Declared MCP servers that can't start (no command/url). */
  readonly mcpIssues: readonly McpIssue[];
  /** `type: mcp_tool` hook actions that are incomplete or target an undeclared server. */
  readonly mcpHookIssues: readonly McpHookIssue[];
  /** Pairs of model-invocable skills whose descriptions are near-identical (precision collision). */
  readonly descriptionOverlaps: readonly DescriptionOverlap[];
  /** Model-invocable skills whose description is so long the trigger signal is buried. */
  readonly descriptionBudgetIssues: readonly DescriptionBudgetIssue[];
  /**
   * Lethal-trifecta findings across subagents + model-invocable skills — a unit
   * holding all three legs (read-private + ingest-untrusted + exfiltrate). Each
   * carries the surface path + kind for reporting/annotations. Shared by `scan`
   * (the report) and the `lethal-trifecta` lint rule (one detector, no drift).
   */
  readonly trifectaFindings: readonly ScanTrifectaFinding[];
  /**
   * SKILL.md body references to a bundled resource that doesn't resolve on disk,
   * across all skills — each carries the skill path for reporting/annotations.
   * Shared by `scan` and the `skill-resource-resolves` lint rule (one detector, no
   * drift).
   */
  readonly skillResourceIssues: readonly ScanSkillResourceFinding[];
  /**
   * Skills whose frontmatter-looking opening has NO `---` fence, so they load as
   * pure body (invisible — no name/description/trigger). Shared by `scan` and the
   * `skill-missing-fence` lint rule (one detector, no drift).
   */
  readonly skillFenceIssues: readonly ScanSkillFenceFinding[];
  /**
   * Functional surface dirs (skills/agents/commands) nested INSIDE the manifest
   * dir (`.claude-plugin/`) where the harness can't see them. Shared by `scan`
   * and the `plugin-dir-layout` lint rule (one detector, no drift).
   */
  readonly pluginLayoutIssues: readonly PluginLayoutFinding[];
  /**
   * Surface directories found by SHAPE in the bounded root set that NO
   * registered harness claims — a harness sitting somewhere vigiles does not
   * read, reported instead of silently graded around (#240). Computed by
   * `core/surface-discovery.ts` from paths alone; shared with the browser twin
   * (one detector, no drift).
   */
  readonly unclaimedSurfaces: readonly UnclaimedSurfaceFinding[];
  /**
   * Lethal trifectas that EMERGE across a delegation edge — a subagent whose
   * effective (own ∪ delegated-to) capability holds all three legs though no
   * single unit does. Shared by `scan` and the `delegation-trifecta` lint rule
   * (one detector, no drift).
   */
  readonly delegationTrifecta: readonly ScanDelegationFinding[];
  /**
   * Hooks that LOOK like they block but silently don't — a block decision on a
   * non-blocking event, or the legacy `decision` field on a permission-gated
   * event (#19009, the #1 verified hook pain). Shared by `scan` and the
   * `hook-block-ineffective` lint rule (one detector, no drift). Empty when the
   * dialect doesn't declare its blocking-event semantics.
   */
  readonly hookBlockFindings: readonly HookBlockFinding[];
  /**
   * Hook `matcher` strings that don't fire as written — a tool-name typo, a
   * matcher that doesn't compile, an MCP pattern that matches no tool name or is
   * too narrow for real server naming, or an undeclared MCP server. Shared by
   * `scan` and the `hook-matcher` lint rule (one detector, no drift).
   */
  readonly hookMatcherFindings: readonly HookMatcherFinding[];
  /**
   * What the harness loads WITHOUT being asked, weighed in ITS OWN unit — and
   * what it does when that is too much. `null` when the adapter declares no
   * budget. Reported, never gated: both corpora this was built against sit near
   * four times the Claude Code threshold, and a rule that fails every real repo
   * on day one is switched off on day one.
   */
  readonly instructionWeight: InstructionWeight | null;
  /** Skills/agents whose `---` block isn't valid YAML — informational (may still load via salvage). */
  readonly malformedFrontmatter: readonly FrontmatterParseIssue[];
  readonly warnings: readonly string[];
  /** Surfaces covered by NEITHER tier — the union count (unchanged). */
  readonly untested: number;
  /**
   * Surfaces with no DETERMINISTIC harness (`*.harness.*`) — free,
   * millisecond, every-push. Feeds the `Tested` ring. Optional so a hand-built
   * report (and any producer predating the split) falls back to `untested`.
   */
  readonly untestedHarness?: number;
  /**
   * Surfaces whose FIRING was never measured — no `*.eval.mjs` covers them. Paid,
   * scheduled, real-model. Feeds the `Evaluated` ring. A DIFFERENT gap from
   * `untestedHarness`, at a cost three orders of magnitude apart — which is
   * exactly why it is a different number and not a slash in one finding.
   */
  readonly unevaluated?: number;
  /**
   * Surfaces whose firing COULD be measured at all — the `Evaluated` ring's
   * denominator. 0 → the ring is n/a (nothing to evaluate), never a false 0.
   */
  readonly evaluable?: number;
  /**
   * HOW the covered surfaces were decided to be covered — declared / colocated /
   * name-mentioned. A coverage count with no provenance is what let a one-line
   * COMMENT confer coverage unnoticed; carrying the derivation makes "28 covered"
   * distinguishable from "28 names that happen to appear in some file".
   */
  readonly coverageEvidence?: EvidenceCounts;
  /**
   * The caveats that QUALIFY the coverage numbers above — "measured, but not
   * this version", "still carrying a marker that stopped counting". Already
   * formatted, because both renderers print the same sentence and a second
   * wording is a second thing to keep true.
   *
   * Absent when there are none, never `[]`: byte-parity between the disk and
   * browser engines is asserted field-for-field, and an empty array on one side
   * against an absent field on the other is a diff where two absent fields are
   * not.
   *
   * ⚠️ THE BROWSER TWIN PRODUCES NONE OF THESE, and only two of the three have
   * an excuse: "measured, but not this version" needs `.vigiles/coverage.json`
   * and the retired-marker note needs to read test files, neither of which a
   * filesystem-free scan has. The retired-SUFFIX note is derivable from the file
   * map alone and is simply not wired there yet. The parity test cannot see the
   * gap either way — no vendored fixture carries any of the three inputs, which
   * is the same blind spot `scan-files.test.ts` documents for the
   * single-skill-at-root branch.
   */
  readonly coverageCaveats?: readonly string[];
  /**
   * Whether the repo has its OWN test setup (a real `package.json` `test` script or
   * a conventional test dir). When true, the `untested` count — which only counts
   * vigiles-native `.eval.mjs`/`.harness.mjs` — is misleading: the team clearly
   * tests, they just don't use vigiles's skill-trigger tier. So the `Tested` ring is
   * contextualized as OPTIONAL rather than reading as a failure (it's advisory /
   * ungraded either way). Optional — the browser `scanFiles` path leaves it unset
   * (false); only the fs-based CLI scan detects it. See gate-first-adoption G3.
   */
  readonly ownTestSignal?: boolean;
  /**
   * Harness-level purity summary: how many scanned agents fall into each purity
   * rung. A high `pure` count means more of the harness is statically testable
   * (deterministic, no mocks); `unrestricted` is the blind-spot count.
   * Computed by `effectSurface()` (one detector, no drift).
   */
  readonly puritySummary: {
    pure: number;
    bounded: number;
    unrestricted: number;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Collect declared MCP servers from the JSON sources (`.mcp.json` + the plugin
 * manifest's `mcpServers`). Codex's TOML `[mcp_servers]` isn't parsed here (a
 * documented gap); the JSON CC shape is the common case. Merged so a server
 * defined in both sources appears once. Shared by the `mcp-config` check (does
 * each server start?) and `mcp-tool-resolves` (is each referenced server here?).
 */
function collectMcpServers(
  root: string,
  layout: PluginLayout,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  const read = (file: string): string | undefined => {
    const p = join(root, file);
    return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
  };
  const collect = (file: string): void => {
    const text = read(file);
    if (text === undefined) return;
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown };
      if (parsed.mcpServers !== null && typeof parsed.mcpServers === "object") {
        Object.assign(servers, parsed.mcpServers);
      }
    } catch {
      /* malformed JSON is the loader's concern, not this check's */
    }
  };
  // The harness's own locations (from the layout — never a hard-coded literal),
  // plus the Agent Plugins standard's root `mcp.json` when the repo ships that
  // manifest. A plugin in the vendor-neutral format declares its servers there,
  // which no harness layout names — without this the MCP checks would silently
  // pass over it.
  for (const file of [
    layout.mcpConfigFile,
    layout.manifestPath,
    ...agentPluginsMcpSources(read),
  ]) {
    collect(file);
  }
  return servers;
}

// Disk-backed IO the moved detectors take by injection (they never import
// `node:fs`, so the browser engine can inject a map-backed pair instead).
const nodeReadFile = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const nodeIsDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The disk (node:fs) wrapper over the shared, node-free
 * {@link detectOwnTestSignal} in scan-core — a real `package.json` `test` script
 * or a conventional test dir. A weak proxy on purpose: it only downgrades an
 * ADVISORY signal from "alarm" to "optional", never changes a grade. Sharing the
 * detector keeps the disk report and the browser demo report byte-identical.
 */
function ownTestSignalOnDisk(dir: string): boolean {
  return detectOwnTestSignal(dir, {
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf-8") : ""),
    existsSync,
  });
}

/** Scan a plugin/repo directory and report its surfaces + structural issues. */
export function scanPlugin(
  dir: string,
  layout?: PluginLayout,
  dialect: HarnessDialect = claudeCodeDialect,
  opts: {
    sharedDirs?: readonly string[];
    sharedDirsRoot?: string;
    /**
     * The repo's `.vigilesrc.json#exclude`, so surface DISCOVERY honours it.
     *
     * It rides in `opts` rather than as a fifth positional parameter because ~25
     * call sites pass the first three and nothing else; a required parameter here
     * would be twenty-odd mechanical edits for one behavioural change.
     *
     * ⚠️ Omitting it is NOT "the repo excludes nothing" — it is "this caller has
     * no ExcludeSet to give", and the walk then reads everything. Today only
     * `audit` supplies one; the `lint` rule checkers below still do not (they
     * share a `(config, silent, adapter, root)` signature through `overBundles`).
     */
    excludes?: ExcludeSet;
    /**
     * The repo's `.vigilesrc.json#surfaceRoots` — repo-relative bases the OWNER
     * declared, read with `lay`'s surface dirs so their skills/subagents/commands
     * are graded instead of merely reported unread.
     *
     * Rides in `opts` for the same reason `excludes` does. Omitting it is "this
     * caller has no declaration to pass", which is also what a repo that set the
     * key gets from a caller that does not forward it: the surfaces stay a
     * FINDING — the honest side to fail on, since nothing is silenced.
     */
    surfaceRoots?: readonly string[];
  } = {},
): ScanReport {
  const lay = layout ?? claudeCodeLayout;
  const cls = makeClassifier(lay);
  const declaredRoots = normalizeSurfaceRoots(opts.surfaceRoots);
  const loaded = loadPlugin(dir, lay, opts.excludes, declaredRoots);
  // Parse the raw `settings.hooks` ONCE at the boundary (parse-don't-validate):
  // tolerant of the Claude Code nested shape AND the Codex flat shape, so every
  // hook detector below consumes typed `HookRegistration[]` instead of re-walking
  // `unknown`. The single seam where the per-harness hook shape is absorbed.
  const hookRegs = normalizeHooks(loaded.settings.hooks);
  const { hooks, inline, manual } = scanHooks(
    hookRegs,
    resolve(dir),
    lay.pluginRootToken,
    existsSync,
  );
  // Hook-event keys are a CLOSED platform set — an unrecognized one is a dead
  // registration (the hook never fires), so flag every unknown (not just typos).
  // ONLY for the canonical object-keyed-by-event shape: a plugin shipping a
  // hooks ARRAY uses a non-CC/custom format whose events live INSIDE each entry
  // (e.g. ananddtyagi/sugar's `[{event:"tool-use",…}]`) — `hookEventNames` reads
  // object keys only and returns [] for an array. We don't interpret a format we
  // don't own.
  const eventNames = hookEventNames(loaded.settings.hooks);
  const allHookEventIssues = verifyHookEvents(eventNames, dialect);
  const hookEventIssues = scoredIssues(allHookEventIssues);
  const instructions: ScanInstructions | null =
    loaded.files[lay.instructionFile] !== undefined
      ? {
          file: lay.instructionFile,
          hasSpec: existsSync(
            join(resolve(dir), `${lay.instructionFile}.spec.ts`),
          ),
        }
      : null;
  const mcpServers = collectMcpServers(resolve(dir), lay);
  const declaredServers = Object.keys(mcpServers);
  const agents = scanAgents(loaded.files, dialect, declaredServers, cls, {
    root: resolve(dir),
    sources: loaded.sources,
  });
  const skills = scanSkills(loaded.files, cls, {
    root: resolve(dir),
    materializeRoot: lay.materializeRoot,
    dialect,
    sources: loaded.sources,
    sharedDirs: opts.sharedDirs,
    sharedDirsRoot: opts.sharedDirsRoot,
    existsSync,
  });
  const puritySummary = summarizePurity(agents);
  const { trifectaFindings, skillResourceFindings, skillFenceFindings } =
    collectSurfaceFindings(agents, skills);
  // Remap frontmatter-family finding paths from the synthetic materialize key to
  // the real on-disk path (dogfood E1), so diagnostics + GitHub annotations point
  // at a file that exists (the same fix ScanAgent/ScanSkill.path already got).
  const remap = <
    T extends { readonly path: string; readonly message?: string },
  >(
    findings: readonly T[],
  ): T[] => remapFindingPaths(findings, loaded.sources, resolve(dir));
  // ONE discovery pass, read three ways: the union (unchanged `untested`), the
  // deterministic tier (`Tested`), and the real-model tier (`Evaluated`). The
  // tiers differ in cost, cadence AND in the question they answer, so collapsing
  // them here would make the difference unrecoverable downstream.
  const coverage = findUntestedSurfaces({
    basePath: dir,
    layout: lay,
    // The SAME `.vigilesrc.json#exclude`, in this walk's string face. Untested-
    // surface discovery is a second walk over the same trees, so leaving it out
    // would have excluded a skill from the GRADE while still naming it in
    // "Untested surfaces: 1" — a report contradicting itself about whether the
    // file exists. `exclude` here NARROWS (it unions with DEFAULT_IGNORE), which
    // is the documented relationship between the repo floor and a rule's own list.
    exclude: opts.excludes ? [...opts.excludes.ignore] : undefined,
  });
  const caveats = coverageCaveats(coverage);
  return {
    dir,
    instructions,
    skills,
    agents,
    hooks,
    inlineHooks: inline,
    manualHookCount: manual,
    commands: Object.keys(loaded.files).filter(cls.isCommand).length,
    // A declared server set counts even when the loader emitted no warning —
    // otherwise a plugin whose servers come from the Agent Plugins `mcp.json`
    // reports "MCP servers: no" while the report lists an MCP finding.
    mcp:
      loaded.warnings.some((w) => w.includes("MCP server")) ||
      declaredServers.length > 0,
    danglingRefs: danglingRefs(resolve(dir), lay),
    // Skill→skill references BY NAME, which `danglingRefs` structurally cannot
    // see: it matches PATHS in EXECUTABLE sources and skips prose by design, and
    // this reference lives in prose. Contents come from the already-loaded file
    // map by its CANONICAL key — keying by `ScanSkill.path` (the real on-disk
    // path) missed every skill in a `skills/` plugin. See `skillRefSources`.
    skillRefIssues: brokenSkillRefs(
      skillRefSources(loaded.files, cls, {
        root: resolve(dir),
        sources: loaded.sources,
      }),
    ).map(formatSkillRefIssue),
    hookEventIssues,
    vocabularyNotes: collectVocabularyNotes(allHookEventIssues, agents),
    frontmatterIssues: remap(frontmatterIssuesFor(loaded.files, cls)),
    frontmatterValueIssues: remap(frontmatterValueIssuesFor(loaded.files, cls)),
    skillMetaIssues: remap(skillMetaIssuesFor(loaded.files, cls)),
    mcpIssues: verifyMcpServers(mcpServers),
    mcpHookIssues: verifyMcpHookTargets(
      loaded.settings.hooks,
      declaredServers,
      dialect,
    ),
    descriptionOverlaps: descriptionOverlapsFor(loaded.files, cls, {
      root: resolve(dir),
      sources: loaded.sources,
    }),
    descriptionBudgetIssues: descriptionBudgetFor(loaded.files, cls),
    trifectaFindings,
    skillResourceIssues: skillResourceFindings,
    skillFenceIssues: skillFenceFindings,
    unclaimedSurfaces: unclaimedSurfaceFindings(
      boundedSurfacePaths(resolve(dir), opts.excludes),
      REGISTERED_LAYOUTS,
      { layout: lay, roots: declaredRoots },
    ),
    pluginLayoutIssues: pluginDirLayoutIssues(
      resolve(dir, dirname(lay.manifestPath)),
      // The hooks dir is a misplaceable functional surface too, but it lives in
      // the layout as a convention PATH (`hooks/hooks.json`), not in surfaceDirs
      // — derive its first segment and dedupe so the detector watches it as well.
      [...new Set([...lay.surfaceDirs, lay.hooksConventionPath.split("/")[0]])],
      { existsSync, isDirectory: nodeIsDirectory },
    ),
    delegationTrifecta: collectDelegationTrifecta(agents, dialect),
    hookBlockFindings:
      blockIneffectiveEventsOf(dialect).length > 0
        ? hookBlockIssues(
            collectHookBlockEntries(
              hookRegs,
              resolve(dir),
              lay.pluginRootToken,
              existsSync,
            ),
            {
              noEffectEvents: new Set(blockIneffectiveEventsOf(dialect)),
              permissionDecisionEvents: new Set(
                permissionDecisionEventsOf(dialect),
              ),
              readFileSync: nodeReadFile,
            },
          )
        : [],
    hookMatcherFindings: hookMatcherIssues(
      collectHookMatchers(hookRegs),
      declaredServers,
      dialect,
    ),
    malformedFrontmatter: remap(malformedFrontmatterFor(loaded.files, cls)),
    warnings: [
      ...loaded.warnings,
      // A harness config left mid-merge is reported BEFORE the author starts
      // guessing why every command is refused — the whole cost of the 2026-08-10
      // wedge was that nothing in the output named `package.json`. A warning, not
      // a scored finding: it is transient repo state, not a fact about how the
      // harness was designed, and a grade that swings on an unresolved merge is
      // noise.
      ...conflictedHarnessConfigs((f) => {
        const p = join(dir, f);
        return existsSync(p) ? nodeReadFile(p) : undefined;
      }).map(mergeConflictWarning),
    ],
    instructionWeight: dialect.instructionBudget
      ? weighInstructions(
          readAlwaysLoaded(dir, dialect.instructionBudget),
          dialect.instructionBudget,
        )
      : null,
    untested: coverage.untested.length,
    untestedHarness: coverage.harness.untested.length,
    unevaluated: coverage.evals.untested.length,
    evaluable: coverage.total,
    coverageEvidence: coverageEvidenceCounts(coverage),
    ...(caveats.length > 0 ? { coverageCaveats: caveats } : {}),
    ownTestSignal: ownTestSignalOnDisk(dir),
    puritySummary,
  };
}

/**
 * LIVE MCP tool resolution for a scanned plugin — the dynamic check no static
 * linter can do: it STARTS each declared MCP server and checks every
 * `mcp__server__tool` the plugin's agents reference actually exists on it
 * (catching rename/removal rot, e.g. `create_issue`→`issue_write`). Reuses the
 * already-computed `report` (its agents' tool lists) + the declared server configs;
 * returns `[]` when the plugin declares no MCP servers (nothing to start). Async +
 * side-effecting (spawns servers) — so `audit` runs it by default only for the
 * user's OWN repo (own-repo, like running your own tools); a FOREIGN plugin's
 * servers are never spawned, and `--fast` opts out. See `verifyMcpContractTools`
 * (core/mcp.ts).
 */
export async function verifyLiveMcpTools(
  report: ScanReport,
  layout: PluginLayout,
  dialect: HarnessDialect,
  timeoutMs = 10000,
): Promise<McpContractToolError[]> {
  // collectMcpServers yields the raw JSON server entries; a malformed one (no
  // command) just fails to start → server-unreachable (handled), so the cast is safe.
  const servers = collectMcpServers(resolve(report.dir), layout) as Record<
    string,
    McpServerConfig
  >;
  if (Object.keys(servers).length === 0) return [];
  const tools = report.agents.flatMap((a) => a.tools ?? []);
  return verifyMcpContractTools(tools, servers, dialect, timeoutMs);
}

/** Render the live MCP tool-check result (human-readable). */
export function formatMcpContractReport(
  errors: readonly McpContractToolError[],
): string {
  if (errors.length === 0) {
    return "Live MCP tool check: every referenced mcp__server__tool resolves ✓";
  }
  const lines = [`Live MCP tool check — ${String(errors.length)} issue(s):`];
  for (const e of errors) lines.push("  ✗ " + mcpContractToolMessage(e));
  return lines.join("\n");
}

/**
 * A plugin MARKETPLACE (`.claude-plugin/marketplace.json`) decomposed into its
 * members. A marketplace either VENDORS its plugins in-tree (string `source`
 * paths, e.g. wshobson/agents — `onDisk` populated) or CURATES external ones
 * (object `source` with a git/url, e.g. obra/superpowers-marketplace,
 * anthropics/claude-plugins-community — `external` populated, nothing on disk).
 * Distinguishing the two lets `scan` report a curated marketplace honestly
 * instead of mistaking it for an empty repo.
 */
export interface MarketplaceInfo {
  readonly name: string;
  /** Member plugin dirs that exist on disk (string `source` paths). */
  readonly onDisk: readonly string[];
  /** Members referencing an off-disk source (url/git/github) — can't be scanned here. */
  readonly external: number;
  readonly total: number;
}

/**
 * Read a `marketplace.json` beside the layout's plugin manifest and classify its
 * members into on-disk vs external. Returns `null` when `dir` is not a
 * marketplace. The source of truth behind {@link expandMarketplace} and the
 * curated-marketplace report in `vigiles audit`.
 */
export function inspectMarketplace(
  dir: string,
  layout: PluginLayout = claudeCodeLayout,
): MarketplaceInfo | null {
  const mpPath = join(dir, dirname(layout.manifestPath), "marketplace.json");
  if (!existsSync(mpPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mpPath, "utf-8"));
  } catch {
    return null;
  }
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return null;
  const name = (parsed as { name?: unknown }).name;
  // Dedupe by resolved path: a marketplace may map several named entries to the
  // SAME plugin dir (TheBushidoCollective/han aliases 338 names onto 159 dirs).
  // Scanning a dir twice is pure noise, so each on-disk member counts once.
  const onDisk: string[] = [];
  const seen = new Set<string>();
  let external = 0;
  for (const entry of plugins) {
    const source = (entry as { source?: unknown }).source;
    if (typeof source !== "string") {
      external++; // external plugin (url/git/github object), not on disk
      continue;
    }
    const abs = resolve(dir, source);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      if (!seen.has(abs)) {
        seen.add(abs);
        onDisk.push(abs);
      }
    } else {
      external++; // a string source that doesn't resolve on disk
    }
  }
  return {
    name: typeof name === "string" ? name : basename(dir),
    onDisk,
    external,
    total: plugins.length,
  };
}

/**
 * If `dir` is a plugin MARKETPLACE (a `marketplace.json` beside the layout's
 * plugin manifest, e.g. `.claude-plugin/marketplace.json`), expand it into the
 * absolute dirs of its member plugins. Returns `null` when there's no
 * marketplace, `[]` when it's a marketplace whose members are all external (not
 * on disk). Used by `vigiles audit` to rank a whole marketplace — wshobson/agents
 * alone ships 80+ plugins under one `marketplace.json`. See {@link inspectMarketplace}.
 */
export function expandMarketplace(
  dir: string,
  layout: PluginLayout = claudeCodeLayout,
): string[] | null {
  const mp = inspectMarketplace(dir, layout);
  return mp ? [...mp.onDisk] : null;
}

// `count` defaults to the number of lines, but a section whose entries span
// multiple lines (Agents: a header + indented issue lines; Hooks: file hooks +
// an inline-summary line) passes the real entity count so the header isn't
// inflated by sub-lines.
function section(
  title: string,
  lines: readonly string[],
  count: number = lines.length,
): string[] {
  if (lines.length === 0) return [];
  return [`${title} (${String(count)}):`, ...lines, ""];
}

/** One skill's report line: ✓/⚠ + name + notes (no-trigger, user-invoked). */
function skillLine(s: ScanSkill): string {
  if (!s.hasDescription) {
    return `  ⚠ ${s.name} (no usable description — no frontmatter description and no body text — can't trigger)`;
  }
  const notes: string[] = [];
  if (s.userInvoked) notes.push("user-invoked");
  return `  ✓ ${s.name}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * The lethal-trifecta section's lines.
 *
 * Three shapes, because the three states differ in what a reader can DO:
 *
 * - HARD (a subagent whose `tools:` names all three legs) — keep the full message;
 *   it names the specific tools to drop.
 * - ADVISORY SUBAGENT (inherits-all) — all carry the same boilerplate paragraph,
 *   so collapse each to a one-liner (feedback P2-6).
 * - SKILLS WITH NO FENCE (`fence: "none"`) — ONE AGGREGATE LINE for the whole
 *   surface plus the names. 🔴 This is the ecosystem default: a skill's
 *   `allowed-tools:` pre-approves rather than restricts (measured 2026-08-11), so
 *   every skill without a `disallowed-tools:` line holds all three legs — which is
 *   ~100% of skills in the wild. Printing that N times would make the section a
 *   wall of identical text about a single fact, and a section that always fires on
 *   every repo is muted within a day, taking the hard findings above it along. It
 *   is one fact about the harness, so it gets one line and one fix.
 *   The count in the header still counts UNITS, not lines — the aggregate must not
 *   make the exposure look smaller than it is.
 *
 * An INEFFECTIVE fence keeps its own line: rare, per-skill, and a real mistake.
 */
function trifectaLines(r: ScanReport): string[] {
  const unfenced = r.trifectaFindings.filter(
    (t) => t.kind === "skill" && t.finding.fence === "none",
  );
  const rest = r.trifectaFindings.filter((t) => !unfenced.includes(t));
  const lines = rest.map((t) => {
    const mark = t.finding.severity === "hard" ? "✗" : "⚠";
    if (t.finding.severity === "hard")
      return `  ${mark} ${t.kind} ${t.name} (${t.path}): ${t.finding.message}`;
    if (t.kind === "skill")
      return `  ${mark} skill ${t.name} (${t.path}): ${t.finding.message}`;
    return `  ${mark} ${t.kind} ${t.name} (${t.path}) — inherits-all contract holds all three legs (declare a tools list dropping one)`;
  });
  if (unfenced.length > 0) {
    const assessable = r.skills.filter((s) => !s.userInvoked).length;
    lines.push(
      `  ⚠ ${String(unfenced.length)} of ${String(assessable)} model-invocable skill(s) declare no \`disallowed-tools:\` fence — each inherits every tool the session grants, so each holds all three legs. \`allowed-tools:\` does NOT fence a skill (it pre-approves; every tool stays callable), so narrowing it changes nothing here. Fix in one line per skill: \`disallowed-tools:\` naming the built-ins that supply a leg it does not need (private read = Read, Grep, Glob, Bash; untrusted intake / exfiltration = WebFetch, WebSearch, Bash).`,
      `      ${unfenced.map((t) => t.name).join(", ")}`,
    );
  }
  return lines;
}

/** One agent's report block: ✗ (broken contract) / ⚠ (inherits all) / ✓ + issues + purity. */
function agentLines(a: ScanAgent): string[] {
  const tools =
    a.tools === null
      ? "tools: (inherits all — no contract)"
      : `tools: ${a.tools.join(", ") || "(none)"}`;
  const broken =
    a.toolIssues.length +
    a.mcpToolIssues.length +
    a.disallowedToolIssues.length;
  let mark = "✓";
  if (broken > 0) mark = "✗";
  else if (a.tools === null) mark = "⚠";
  // Purity is an informational health signal (not a structural defect); mark it
  // clearly so a reader knows which rung this agent is on.
  const PURITY_TAGS: Record<string, string> = {
    pure: "pure",
    bounded: "bounded",
    unrestricted: "unrestricted",
  };
  const purityTag = PURITY_TAGS[a.purity] ?? "unrestricted";
  const lines = [`  ${mark} ${a.name} — ${tools} [${purityTag}]`];
  for (const issue of a.toolIssues) lines.push(`      ✗ ${issue.message}`);
  for (const issue of a.mcpToolIssues) lines.push(`      ✗ ${issue.message}`);
  for (const issue of a.disallowedToolIssues)
    lines.push(`      ✗ ${issue.message}`);
  return lines;
}

/** Format a scan report as human-readable text. */
/**
 * Read every unconditionally-loaded instruction file off disk.
 *
 * Separate from `loadPlugin` on purpose: that materializes the harness's
 * SURFACES (skills, agents, hooks), while this reads what the harness loads
 * before any surface is involved — including `.claude/rules/**`, which is
 * exactly the directory a repo relocates into when it wants the root file to
 * look smaller.
 */
function readAlwaysLoaded(
  dir: string,
  budget: InstructionBudget,
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    for (const entry of readdirSync(abs)) {
      const child = `${rel}/${entry}`;
      if (statSync(join(dir, child)).isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), "utf-8");
    }
  };
  // `**/NAME` — Codex reads nested AGENTS.md root-to-leaf and they all pay into
  // the SAME budget, so leaving them out under-reports in the one direction that
  // matters: the harness truncates silently, and an under-report reads as "you
  // are fine". Skipped dirs are the ones that are never the user's instructions
  // and would dominate the walk.
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor"]);
  const findNested = (name: string, rel = ""): void => {
    const abs = rel === "" ? dir : join(dir, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const child = rel === "" ? entry : `${rel}/${entry}`;
      const childAbs = join(dir, child);
      if (statSync(childAbs).isDirectory()) findNested(name, child);
      else if (entry === name && out[child] === undefined)
        out[child] = readFileSync(childAbs, "utf-8");
    }
  };
  for (const glob of budget.alwaysLoaded) {
    if (!glob.includes("*")) {
      const abs = join(dir, glob);
      if (existsSync(abs) && statSync(abs).isFile())
        out[glob] = readFileSync(abs, "utf-8");
    } else if (glob.endsWith("/**")) walk(glob.slice(0, -3));
    else if (glob.startsWith("**/")) findNested(glob.slice(3));
  }
  return out;
}

/**
 * The weight report. States the SUM first and the per-file breakdown second,
 * because the sum is the number a reader can act on and the breakdown is only
 * where to start.
 *
 * The verb changes with the harness on purpose: over budget on Claude Code is
 * "warns" (costs money, rules still arrive), on Codex it is "truncates" (rules
 * silently do not arrive). Same number, different emergency.
 */
function instructionWeightLines(w: InstructionWeight): string[] {
  const g = (n: number): string =>
    String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const head = `Always-loaded instructions: ${g(w.total)} ${w.unit} (budget ${g(w.limit)})`;
  if (w.overBy === null) return [head];
  const factor = (w.total / w.limit).toFixed(1);
  const consequence =
    w.onExceed === "truncates"
      ? "past the budget is SILENTLY TRUNCATED — those rules never reach the model"
      : "the harness warns; the rules still reach the model, you pay for them every request";
  return [
    `${head} — ${factor}x OVER by ${g(w.overBy)} ${w.unit}`,
    `  ${consequence}`,
    ...w.files.slice(0, 5).map((f) => `  ${g(f.size).padStart(9)}  ${f.path}`),
    ...(w.files.length > 5
      ? [`  …and ${String(w.files.length - 5)} more`]
      : []),
  ];
}

export function formatScanReport(r: ScanReport): string {
  const out: string[] = [`Scan: ${r.dir}`, ""];

  if (r.instructions) {
    const tag = r.instructions.hasSpec
      ? "spec-managed"
      : "hand-written, no spec";
    out.push(`Instructions: ${r.instructions.file} (${tag})`, "");
  }

  // Right under the instruction file, because that is the line a reader is
  // already looking at when they wonder what it costs.
  if (r.instructionWeight) out.push(...instructionWeightLines(r.instructionWeight), ""); // prettier-ignore

  out.push(...section("Skills", r.skills.map(skillLine)));

  out.push(...section("Agents", r.agents.flatMap(agentLines), r.agents.length));

  const hookMark: Record<HookStatus, string> = {
    ok: "✓",
    missing: "✗",
    unresolved: "?",
  };
  const hookNote: Record<HookStatus, string> = {
    ok: "",
    missing: " (referenced but MISSING)",
    unresolved: " (unresolved var — can't check)",
  };
  const hookLines = r.hooks.map(
    (h) => `  ${hookMark[h.status]} ${h.script}${hookNote[h.status]}`,
  );
  if (r.inlineHooks > 0) {
    hookLines.push(
      `  · ${String(r.inlineHooks)} inline hook(s) (no script file)`,
    );
  }
  out.push(...section("Hooks", hookLines, r.hooks.length + r.inlineHooks));

  out.push(
    ...section(
      "Broken references",
      r.danglingRefs.map((ref) => `  ✗ ${ref} (referenced but MISSING)`),
    ),
  );

  out.push(
    ...section(
      "Hook events",
      r.hookEventIssues.map((i) => `  ✗ ${i.message}`),
    ),
  );

  // Advisory, never scored — a name vigiles cannot confirm, or a real one the
  // platform withholds only under a condition it cannot see. Printed with `·`
  // rather than `✗` so it reads as a note about vigiles's knowledge, not a
  // defect in the repo being audited.
  out.push(
    ...section(
      "Vocabulary notes (advisory, not graded)",
      (r.vocabularyNotes ?? []).map((n) => `  · ${n.where}: ${n.message}`),
    ),
  );

  out.push(
    ...section("Frontmatter", [
      ...r.frontmatterIssues.map((i) => `  ✗ ${i.message}`),
      ...r.frontmatterValueIssues.map((i) => `  ✗ ${i.message}`),
    ]),
  );

  out.push(
    ...section(
      "MCP config",
      r.mcpIssues.map((i) => `  ✗ ${i.message}`),
    ),
  );

  out.push(
    ...section(
      "MCP hook targets",
      r.mcpHookIssues.map((i) => `  ✗ ${i.message}`),
    ),
  );

  out.push(
    ...section(
      "Description overlap (precision risk)",
      r.descriptionOverlaps.map((o) => `  ⚠ ${o.message}`),
    ),
  );

  out.push(
    ...section(
      "Description budget (trigger-signal risk)",
      r.descriptionBudgetIssues.map((o) => `  ⚠ ${o.message}`),
    ),
  );

  out.push(
    ...section(
      "Lethal trifecta (prompt-injection exfil risk)",
      trifectaLines(r),
      // Count UNITS, not lines: the unfenced-skill aggregate collapses many units
      // into one line, and a header that counted lines would understate exposure.
      r.trifectaFindings.length,
    ),
  );

  out.push(
    ...section(
      "Skill bundled resources",
      r.skillResourceIssues.map(
        (s) =>
          `  ✗ ${s.name}: ${s.finding.ref} (line ${String(s.finding.line)}) — bundled resource not found`,
      ),
    ),
  );

  out.push(
    ...section(
      "Invisible skills (missing frontmatter fence)",
      r.skillFenceIssues.map(
        (s) =>
          `  ✗ ${s.name} (${s.path}): opens with \`${s.finding.key}:\` but no \`---\` fence — loads as body, never fires`,
      ),
    ),
  );

  out.push(
    ...section(
      "Misplaced plugin directories",
      r.pluginLayoutIssues.map((p) => `  ✗ ${p.message}`),
    ),
  );

  // A harness sitting where no adapter reads (#240). Printed as a ✗ section like
  // any other structural defect, because that is what it is: the grade above it
  // was computed without this directory in it, and the old behaviour was to say
  // nothing at all while returning A (100/100).
  out.push(
    ...section(
      "Surfaces no harness reads",
      r.unclaimedSurfaces.map((u) => `  ✗ ${u.message}`),
    ),
  );

  out.push(
    ...section(
      "Lethal trifecta across delegation (blast radius)",
      r.delegationTrifecta.map(
        (d) => `  ⚠ ${d.finding.name} (${d.path}): ${d.finding.message}`,
      ),
    ),
  );

  out.push(
    ...section(
      "Ineffective hook guards (false confidence)",
      r.hookBlockFindings.map(
        (h) => `  ✗ [${h.event}] ${h.scriptPath ?? "(inline)"}: ${h.message}`,
      ),
    ),
  );

  out.push(
    ...section(
      "Hook matchers that don't fire as written",
      r.hookMatcherFindings.map((m) => `  ✗ ${m.message}`),
    ),
  );

  const facts: string[] = [];
  if (r.commands > 0) facts.push(`Commands: ${String(r.commands)}`);
  facts.push(`MCP servers: ${r.mcp ? "yes" : "no"}`);
  facts.push(`Untested surfaces: ${String(r.untested)}`);
  // The two tiers, named separately — a surface with a deterministic harness and
  // no eval is NOT the same position as one with neither. Shown only when the
  // producer supplied the split (a hand-built report may not have).
  if (r.untestedHarness !== undefined && r.unevaluated !== undefined) {
    facts.push(
      `  no harness: ${String(r.untestedHarness)} · firing never measured: ${String(r.unevaluated)}`,
    );
  }
  // …and HOW the rest passed. Without this the count is unfalsifiable from the
  // outside: "28 covered" and "28 names that appear in some file" print the same.
  const evidenceLine = r.coverageEvidence
    ? formatEvidence(r.coverageEvidence)
    : "";
  if (evidenceLine) facts.push(`  ${evidenceLine}`);
  // …and what DISQUALIFIES part of it. Same lines `lint` prints, from the same
  // builder — see `coverageCaveats`. They already carry their own indent.
  facts.push(...(r.coverageCaveats ?? []));
  // Effect surface: harness-level purity summary across all scanned agents.
  // Informational (higher pure% = more constrained, cheaper to test); shown
  // only when there are agents to summarize (no agents → no summary line).
  if (r.agents.length > 0) {
    const { pure, bounded, unrestricted } = r.puritySummary;
    facts.push(
      `Effect surface: ${String(pure)} pure · ${String(bounded)} bounded · ${String(unrestricted)} unrestricted`,
    );
  }
  out.push(...facts, "");

  // The dangling-ref warning is now shown as a first-class ✗ section above, so
  // drop it from the free-text list to avoid saying the same thing twice.
  const warnings = r.warnings.filter(
    (w) => !w.includes("intra-plugin file(s) that don't exist"),
  );
  if (warnings.length > 0) {
    out.push("Warnings:", ...warnings.map((w) => `  - ${w}`), "");
  }

  // Skill-metadata is a RECOMMENDATION, not a structural defect (the skill loads
  // via fallbacks) — reported as a soft note, never counted in the verdict.
  if (r.skillMetaIssues.length > 0) {
    out.push(
      `ℹ ${String(r.skillMetaIssues.length)} skill(s) lack an explicit frontmatter name/description (recommended for a reliable trigger surface) — they still load via fallback`,
      "",
    );
  }

  // One discovery nudge toward compiled hooks (never per-hook); the hand-written
  // shell lane stays first-class, so this is a recommendation, not a defect.
  if (r.manualHookCount > 0) {
    out.push(`ℹ ${preferCompiledHooksMessage(r.manualHookCount)}`, "");
  }

  // Malformed-YAML frontmatter is INFORMATIONAL, not a structural defect: js-yaml
  // is stricter than some loaders (a colon/quote/<example> in a one-line
  // description trips it though the file may still load), and the other fields are
  // salvaged. Surfaced as a note; the frontmatter-valid lint rule warns on it.
  if (r.malformedFrontmatter.length > 0) {
    out.push(
      `ℹ ${String(r.malformedFrontmatter.length)} file(s) have frontmatter that isn't valid YAML — fields may not parse as intended (verify before enforcing \`frontmatter-valid\`)`,
      "",
    );
  }

  const broken =
    r.hooks.filter((h) => h.status === "missing").length +
    r.skills.filter((s) => !s.hasDescription).length +
    r.agents.reduce(
      (n, a) =>
        n +
        a.toolIssues.length +
        a.mcpToolIssues.length +
        a.disallowedToolIssues.length,
      0,
    ) +
    r.danglingRefs.length +
    r.hookEventIssues.length +
    r.frontmatterIssues.length +
    r.frontmatterValueIssues.length +
    r.mcpIssues.length +
    r.mcpHookIssues.length +
    r.skillResourceIssues.length +
    r.skillFenceIssues.length +
    r.pluginLayoutIssues.length +
    r.unclaimedSurfaces.length +
    r.hookBlockFindings.length +
    r.hookMatcherFindings.length +
    // Only HARD trifectas (✗) count as STRUCTURAL defects here. Both severities are
    // now GRADED (see trifectaExposure — an inherits-all unit holds the three legs
    // implicitly and everything else besides), but this line tallies structural
    // defects, not the safety axis; promoting every idiomatic inherits-all unit to
    // "broken" in the CLI summary is a separate, louder call. The delegation-trifecta
    // ⚠ risk is ungraded and does NOT count either.
    r.trifectaFindings.filter((t) => t.finding.severity === "hard").length;
  out.push(
    broken > 0
      ? `⚠ ${String(broken)} structural issue(s) — see ✗/⚠ above`
      : // 🔴 "NOTHING WAS FOUND" IS NOT "NOTHING IS WRONG" (#240). With zero
        // surfaces read, `broken` is zero for want of anything to count, and this
        // line was the sentence the reporter quoted under an A (100): a repo whose
        // 37 skills sat in a directory this tool does not know by name.
        isEmptyMachine(r)
        ? "⚠ nothing to check — 0 skills, 0 agents, 0 commands were read"
        : "✓ no structural issues found",
  );
  return out.join("\n");
}
