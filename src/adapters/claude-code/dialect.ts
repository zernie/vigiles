/**
 * claudeCodeDialect — the Claude Code adapter's `HarnessDialect` (format axis).
 * The concrete dialect is DEFINED here, in the adapter, symmetric with the other
 * four ports (`claudeCodeLayout`/`Runtime`/`HookProtocol`/`ModelMock`): the core
 * holds only the `HarnessDialect` interface and never a harness's vocabulary. The
 * rule-enforcer/validator receive this by injection (`compileAgent(spec, { dialect })`,
 * the CLI/composition root supplies it). A second harness defines its own dialect
 * in its adapter (e.g. `src/adapters/codex/dialect.ts` exporting `codexDialect`).
 */
import type { HarnessDialect } from "../../core/dialect.js";
import { claudeCodeEventCapabilities } from "./event-capability.js";
import {
  claudeCodeAvailableAgentTools,
  claudeCodeConditionalAgentToolNames,
  claudeCodeHookEventNames,
  claudeCodeHookEventVocabulary,
  claudeCodeSideEffectingAgentTools,
  claudeCodeSubagentToolVocabulary,
  claudeCodeWithheldAgentTools,
} from "./vocabulary.js";

/**
 * The Claude Code built-in subagent tool catalog as a `const` tuple, so a typed
 * authoring surface can derive a LITERAL union (`ClaudeCodeBuiltinTool`) from it.
 *
 * DERIVED, not authored: it is exactly the vocabulary's declarable terms — the
 * ones the platform provides outright plus the ones it withholds only under a
 * condition. Both halves are legitimate to write in a `tools:` line, which is
 * why `Agent` belongs here and used to sit in `neverAvailableTools` instead.
 * Because this is a projection rather than a second hand-kept list, the two can
 * no longer disagree; `vocabularyProjectionProblems` asserts it in the
 * conformance kit rather than leaving it to care.
 */
export const claudeCodeBuiltinAgentTools = [
  ...claudeCodeAvailableAgentTools,
  ...claudeCodeConditionalAgentToolNames,
] as const;

/**
 * The Claude Code side-effecting tools (the complement of read-only within
 * `builtinAgentTools`). Authored in `vocabulary.ts` beside the catalog it
 * partitions, because a name added to the catalog without a decision here would
 * silently be classified read-only.
 */
export const claudeCodeSideEffectingTools = claudeCodeSideEffectingAgentTools;

export const claudeCodeDialect: HarnessDialect = {
  name: "claude-code",
  // The tool contract a subagent may declare — the rails it runs on. Anything
  // else must be an MCP tool, else it's a typo / nonexistent tool.
  builtinAgentTools: claudeCodeBuiltinAgentTools,
  // Tools the platform removes UNCONDITIONALLY, whatever the list says — so a
  // subagent listing one is a guaranteed-dead reference only a compiler catches.
  // Derived from the vocabulary's `withheld` terms. `Agent` and `ExitPlanMode`
  // are deliberately absent: the vendor removes both only under a stated
  // condition (depth limit / `permissionMode: plan`), so they are `conditional`
  // and reported as a note. Listing them here is what told delegating subagents
  // to delete the tool they exist to use.
  neverAvailableTools: claudeCodeWithheldAgentTools,
  mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
  // Claude Code's own built-in MCP server: the IDE integration provides
  // `mcp__ide__getDiagnostics` / `mcp__ide__executeCode` at runtime without any
  // plugin declaring it, so a contract that lists those must NOT be flagged as
  // referencing an undeclared server (the mcp-tool-resolves allowlist).
  knownMcpServers: ["ide"],
  // The real Claude Code hook events — all 31 the vendor documents, derived from
  // `claudeCodeHookEventNames`. This list held 9 until 2026-08-17; `Setup` was
  // reported as "never fires" and the other 21 absentees drew nothing at all,
  // because whether an unknown name was accused or ignored came down to its edit
  // distance from the 9 we had. See `vocabulary.ts` for the capture.
  hookEvents: claudeCodeHookEventNames,
  // Events where a block decision is silently ignored ENTIRELY — no veto AND no
  // model feedback (exit 2 there writes stderr only to the user). These are the
  // ONLY events hook-block-ineffective flags as wrong-event. PostToolUse is NOT
  // here: its exit 2 feeds stderr back to the model (a legitimate nudge/feedback
  // channel), so flagging it would cry wolf (e.g. vigiles's own refs-nudge.sh).
  noEffectHookEvents: [
    "SessionStart",
    "SessionEnd",
    "Notification",
    "PreCompact",
  ],
  // What Claude Code loads unasked, and what it does with too much of it.
  //
  // WARNS, does not truncate: `/doctor` reports "Large file will impact
  // performance" and the instructions still reach the model. So being over
  // budget here costs money and attention — not rules. (Codex is the opposite;
  // see its dialect, and see why `onExceed` is reported at all.)
  //
  // 🔴 WHICH FILES THE SUM IS TAKEN OVER IS NO LONGER A FIELD HERE. It was
  // `alwaysLoaded: ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md",
  // ".claude/rules/**"]` — globs this dialect wrote and the CORE expanded by
  // walking the repository, which is the defect zernie/vigiles#262 records.
  // The set now comes from `claudeCodeLayout.instructionChain`, which can say
  // what a glob cannot: that a `paths:`-scoped rule loads on demand, and that
  // `CLAUDE.local.md` is a per-machine file that is read and never SCORED.
  //
  // What stays here is the harness's own NUMBER, which is a format fact: the
  // rules directory counts on a MEASUREMENT, not a doc — a consumer repo moved
  // 225 837 characters out of CLAUDE.md into it and the request cost did not
  // move, because the harness loads it either way. A per-file check would have
  // called that split a success.
  instructionBudget: {
    unit: "chars",
    limit: 40000,
    onExceed: "warns",
    capturedFrom:
      "claude-code /doctor large-file warning; the rules dir measured 2026-09-16 in a consumer repo",
  },
  // The capability table — what each event CARRIES and HONOURS. Nine of the 31
  // events, each with its basis; see ./event-capability.ts. The three flat lists
  // above are kept for now and are ASSERTED against this table in
  // event-capability.test.ts, so there is one source rather than two truths.
  eventCapabilities: claudeCodeEventCapabilities,
  // PreToolUse is the one event whose deny needs the structured
  // `hookSpecificOutput.permissionDecision:"deny"`; the legacy top-level
  // `decision` field is ignored there.
  permissionDecisionHookEvents: ["PreToolUse"],
  // 🔴 THIS LIST GAINED `AGENTS.md` ON 2026-09-21, REVERSING WHAT STOOD HERE.
  // The comment it replaces read "Claude Code natively reads CLAUDE.md only — it
  // does NOT auto-load AGENTS.md (anthropics/claude-code#34235 is open; AGENTS.md
  // works solely via an `@AGENTS.md` import inside CLAUDE.md or a symlink)".
  // That is no longer true. Vendor, `https://code.claude.com/docs/en/memory`,
  // read 2026-09-21:
  //
  //   "Claude Code can read `AGENTS.md` as your project instructions, so a
  //    repository already set up for other coding agents works without adding a
  //    `CLAUDE.md`, an import, or a setting."
  //
  //   "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later."
  //
  // The conditions under which it actually loads are NOT a dialect fact and are
  // not restated here — they depend on sibling files and on settings, which is
  // exactly why they live in `./instruction-chain.ts` as a method. This field
  // answers the narrower question its docblock asks: which filenames does this
  // harness READ as project instructions.
  //
  // 🔴 WHAT CHANGED WHEN `AGENTS.md` WAS ADDED — MEASURED, NOT EXPECTED, AND THE
  // EXPECTED ANSWER WAS WRONG. The obvious worry is `detect`: a second target
  // ought to make this adapter score a bare `AGENTS.md` repository and start
  // fighting Codex for it. It does not, and cannot, because `detect` never reads
  // this field — it asks the LAYOUT (`claudeCodeLayout.instructionFile`).
  // Recorded by instrumenting `adapter.detect` with a call-recording predicate,
  // before and after the edit:
  //
  //     detect asked: [".claude-plugin/plugin.json", ".claude/settings.json",
  //                    "CLAUDE.md"]        — IDENTICAL both ways
  //     claims("AGENTS.md"): false         — IDENTICAL both ways
  //
  // That separation is load-bearing rather than incidental: `claims` is derived
  // from `layoutLocations`, and `adapter-properties.test.ts` refuses a `detect`
  // that asks about a path `claims` does not cover. So a Claude Code adapter
  // that detected on `AGENTS.md` would have to CLAIM it, and two registered
  // adapters claiming one path is the collision `claims` exists to prevent. The
  // file stays owned by Codex and merely READ here — which is the same reason
  // `instruction-chain.ts` keeps `AGENTS.md` as a local constant instead of
  // putting it on `PluginLayout`.
  //
  // THE ONE CONSUMER THAT DID CHANGE is `core/validate.ts:300`
  // (`recognized = dialect?.instructionTargets ?? INSTRUCTION_FILES`), and the
  // change fixes a real inconsistency. Measured on an `AGENTS.md` path:
  //
  //     before — with the CC dialect injected: []
  //     before — with NO dialect:              ["require-instructions-spec"]
  //     after  — either way:                   ["require-instructions-spec"]
  //
  // i.e. injecting this dialect used to make vigiles recognise FEWER instruction
  // files than its own no-dialect default, so an `AGENTS.md` that Claude Code
  // really does read was linted as if it were an ordinary markdown file. Full
  // unit suite with this edit alone: 4 failed / 4185 passed — the same four
  // `spec.test.ts` pylint/rubocop CLI tests that fail on this branch regardless.
  //
  // ORDER IS PART OF THE CONTRACT: `instructionTargets[0]` is the default
  // COMPILE target (`core/compile.ts:792`), and what `vigiles init` writes for
  // Claude Code is still `CLAUDE.md`. `AGENTS.md` is second because this harness
  // reads it, not because it authors it. `docs/adapter-api.md` already documented
  // `["CLAUDE.md","AGENTS.md"]` for this adapter; the code now agrees with it.
  instructionTargets: ["CLAUDE.md", "AGENTS.md"],
  pluginRootToken: "${CLAUDE_PLUGIN_ROOT}",
  // Claude Code reads the full SKILL.md frontmatter set. Spelled out rather than
  // aliased to the compiler's RENDERABLE_SKILL_FRONTMATTER_KEYS: that constant is
  // "what vigiles can write", this list is "what Claude Code reads", and a new
  // renderable key must not silently become a claim about the vendor.
  skillFrontmatterKeys: [
    "name",
    "description",
    "disable-model-invocation",
    "context",
    "argument-hint",
    "allowed-tools",
    "disallowed-tools",
  ],
  // Tools that produce side effects in Claude Code. The complement — the
  // read-only tools — are: Read, Grep, Glob, ToolSearch, LSP, ListAgents,
  // TaskGet, TaskList, CronList. Bash (and PowerShell) are side-effecting
  // because `cat` and `rm -rf` are the same tool at the tool-name level — the
  // sandbox is the only closure for subprocess effects.
  sideEffectingTools: claudeCodeSideEffectingTools,
  // The richer catalogs the flat lists above project from — status per term,
  // with the vendor capture they were read from. An unknown name resolves
  // against these to an `unrecognised` ADVISORY that names vigiles as the
  // possibly-stale party, instead of the silence-or-accusation coin flip that
  // edit distance used to decide.
  hookEventVocabulary: claudeCodeHookEventVocabulary,
  subagentToolVocabulary: claudeCodeSubagentToolVocabulary,
};

// ---------------------------------------------------------------------------
// Typed tool vocabulary — the compile-time half of the purity contract.
//
// Derives literal unions from the `const` catalogs above so the
// `vigiles/claude-code` typed `agent`/`skill` can reject an invalid
// `purity`×`tools` combination at the spec's own `tsc`. Mirrors the runtime
// ladder in `core/effects.ts`: `pure` = read-only built-ins; `bounded` =
// read-only ∪ decidable side-effecting ∪ `Bash`.
// ---------------------------------------------------------------------------

/** Every Claude Code built-in subagent tool (literal union). */
export type ClaudeCodeBuiltinTool =
  (typeof claudeCodeBuiltinAgentTools)[number];

/** The side-effecting subset (literal union). */
export type ClaudeCodeSideEffectingTool =
  (typeof claudeCodeSideEffectingTools)[number];

/**
 * Read-only built-in tools — the complement of the side-effecting set within
 * the built-in catalog. The tools a `pure` CC unit may declare.
 */
export type ClaudeCodeReadOnlyTool = Exclude<
  ClaudeCodeBuiltinTool,
  ClaudeCodeSideEffectingTool
>;

/**
 * Tools a `bounded` CC unit may declare: read-only ∪ the decidable
 * side-effecting tools (Write/Edit/NotebookEdit) ∪ `Bash`/`PowerShell` (whose
 * command is decided at RUNTIME by the gate). Bars MCP / unknown / wildcard —
 * those are simply not in the built-in union, so listing one is a `tsc` error.
 *
 * `MultiEdit` was listed here until 2026-08-17. It is not a Claude Code tool —
 * it appears zero times across the vendor's documentation — so it is gone along
 * with `BashOutput`, `KillBash` and `LS`.
 */
export type ClaudeCodeBoundedTool =
  | ClaudeCodeReadOnlyTool
  | "Write"
  | "Edit"
  | "NotebookEdit"
  | "Bash"
  | "PowerShell";

export type { HarnessDialect } from "../../core/dialect.js";
