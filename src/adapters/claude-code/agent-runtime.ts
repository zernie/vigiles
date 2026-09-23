/**
 * vigiles — Agent runtime: the PreToolUse tool-contract rail.
 *
 * A subagent declares an allowed-tools contract in its frontmatter (`tools:`).
 * But that field is documentation, not a hard runtime boundary (Claude Code
 * #4740/#21460, SDK #172): permissions are session-wide, a subagent inherits the parent
 * session's grants, and `tools:` only filters what's *offered* — it can't deny
 * what the session allows. The deterministic layer that actually closes the gap
 * is a **PreToolUse hook** that blocks any tool the active agent's contract
 * doesn't list.
 *
 * This is the same emit-a-hook pattern the skill runtime already ships
 * (`src/adapters/claude-code/skill-runtime.ts`): there a `Stop` hook reads the active skill's
 * compiled SKILL.md and runs its result gate; here a `PreToolUse` hook reads
 * the active agent's compiled `.md`, parses its `tools:` allowlist, and
 * allows/denies the tool call. The compiled markdown's frontmatter is the
 * single source of truth — the same list that documents intent IS the list the
 * hook enforces, so the two agree by construction (see `enforcedTools`).
 *
 * Which agent is active is recorded in `.vigiles/active-agent.json` — Claude
 * Code hooks don't surface the dispatched subagent, so vigiles records it
 * (mirrors `.vigiles/active-skill.json`). The decision logic below is
 * harness-agnostic and fully testable.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";

import { decidePurityGate } from "../../core/effects.js";
import type { PurityLevel } from "../../core/effects.js";
import { claudeCodeDialect } from "./dialect.js";
import {
  ACTIVE_AGENT_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "../../local-files.js";
import { hasEffectBoundary, readEffectActive } from "./effect-region.js";
import { parseAgentTools, parseAgentToolList } from "./agent-tools.js";

// ---------------------------------------------------------------------------
// Parse the tool contract from a compiled agent .md
// ---------------------------------------------------------------------------

// The pure `tools:`/`allowed-tools:` parsers live in a node-free leaf so the
// browser audit engine can read a contract without pulling this file's node:fs
// rail; re-exported here so every existing consumer of agent-runtime is unchanged.
export { parseAgentTools, parseAgentToolList };

const PURITY_RE = /<!--\s*vigiles:purity:(pure|bounded|unrestricted)\s*-->/;

/**
 * Parse the declared purity floor from a compiled agent's `.md` — the
 * `<!-- vigiles:purity:LEVEL -->` marker `compile` emits (see `purityMarker`).
 * Returns null when no marker is present (the unit declared no floor, so the
 * purity gate imposes no constraint). The single source of truth the runtime
 * gate reads, exactly like `tools:` for the tool-contract rail.
 */
export function parseAgentPurity(markdown: string): PurityLevel | null {
  const m = PURITY_RE.exec(markdown);
  return m ? (m[1] as PurityLevel) : null;
}

// ---------------------------------------------------------------------------
// The pure decision: is this tool inside the contract?
// ---------------------------------------------------------------------------

export interface PreToolDecision {
  /** Whether the tool call is allowed (true) or blocked (false). */
  readonly allow: boolean;
  /** Message fed back to the model on a block; empty on allow. */
  readonly message: string;
}

/**
 * Decide whether `tool` is allowed under an agent's tool contract. Pure, so the
 * rail is unit-testable without spawning anything.
 *
 * - `allowed === null` → the agent declared no `tools:` line, so it inherits
 *   everything and the rail imposes no restriction (allow).
 * - otherwise → allow iff the tool is in the allowlist; deny anything else,
 *   feeding the contract back to the model so it self-corrects.
 */
export function decidePreToolUse(
  allowed: readonly string[] | null,
  tool: string,
): PreToolDecision {
  if (allowed === null) return { allow: true, message: "" };
  if (allowed.includes(tool)) return { allow: true, message: "" };
  const list = allowed.length > 0 ? allowed.join(", ") : "(none)";
  return {
    allow: false,
    message:
      `Tool "${tool}" is not in this subagent's allowed-tools contract ` +
      `(${list}). Use only the listed tools, or widen the agent's \`tools\`.`,
  };
}

// ---------------------------------------------------------------------------
// Active-agent tracking — a depth-aware STACK (mirrors .vigiles/active-skill.json)
// ---------------------------------------------------------------------------
//
// Claude Code v2.1.172 added nested subagents (a subagent with the spawn tool can
// dispatch its own, up to depth 5). A single active-agent slot is NOT nesting-safe:
// when an inner subagent returns, clearing the whole slot drops the OUTER agent's
// contract while it is still running, so the PreToolUse gate then allows a tool the
// outer subagent forbids — a CONTRACT ESCAPE. The fix (certified in TLC, see
// research/prototypes/typed-spec-formal-verification/AgentWindowStack.tla) is a
// STACK: push on dispatch, pop on SubagentStop (back to the parent), gate on the
// stack TOP. Counterexample the flat model fails and the stack model passes:
// Open(writer); Open(writer); Stop; Call(Bash).

const ACTIVE_PATH = `${VIGILES_DIR}/${ACTIVE_AGENT_FILE}`;

/**
 * Read the active-agent stack (oldest → newest; the dispatched subagent chain).
 * Back-compat: a legacy single-slot `{ agent: string }` marker reads as a one-frame
 * stack; a malformed file or non-string entries → an empty stack (fail-open).
 */
export function readActiveStack(cwd: string): string[] {
  const p = resolve(cwd, ACTIVE_PATH);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
      stack?: unknown;
      agent?: unknown;
    };
    if (Array.isArray(parsed.stack)) {
      return parsed.stack.filter((x): x is string => typeof x === "string");
    }
    // legacy single-slot format
    if (typeof parsed.agent === "string") return [parsed.agent];
    return [];
  } catch {
    return [];
  }
}

function writeActiveStack(cwd: string, stack: readonly string[]): void {
  const p = resolve(cwd, ACTIVE_PATH);
  if (stack.length === 0) {
    if (existsSync(p)) rmSync(p);
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  ensureLocalFilesIgnored(dirname(p));
  writeFileSync(p, JSON.stringify({ stack }) + "\n");
}

/**
 * Push a dispatched subagent onto the active stack (a `PreToolUse` spawn). The
 * PreToolUse gate then enforces this subagent's contract until it returns. Under
 * nesting each dispatch pushes a frame, so the chain is tracked, not overwritten.
 */
export function pushActiveAgent(cwd: string, agentPath: string): void {
  writeActiveStack(cwd, [...readActiveStack(cwd), agentPath]);
}

/**
 * Pop the top frame — the subagent returned (`SubagentStop`), so control returns
 * to its PARENT (the next frame down), whose contract the gate enforces again.
 * This is the nesting-safe close, distinct from {@link clearActiveAgent} (which
 * drops the whole stack). Popping an empty stack is a no-op.
 */
export function popActiveAgent(cwd: string): void {
  const stack = readActiveStack(cwd);
  stack.pop();
  writeActiveStack(cwd, stack);
}

/**
 * Push a subagent frame (the manual `agent-start` fallback + the deterministic
 * spawn open-signal both use this). A single call is equivalent to a one-frame
 * stack, so the top — what the gate reads — is this agent. Alias of
 * {@link pushActiveAgent} kept under the historical name.
 */
export function setActiveAgent(cwd: string, agentPath: string): void {
  pushActiveAgent(cwd, agentPath);
}

/**
 * Clear the WHOLE stack (a hard reset / session end). Distinct from
 * {@link popActiveAgent}, which returns to the parent frame. Idempotent.
 */
export function clearActiveAgent(cwd: string): void {
  const p = resolve(cwd, ACTIVE_PATH);
  if (existsSync(p)) rmSync(p);
}

/**
 * The active agent's compiled `.md` — the STACK TOP — or null when none is active.
 * The gate reads the top, so a returned nested subagent reveals its parent's
 * contract again (the contract-escape fix).
 */
export function readActiveAgent(cwd: string): string | null {
  const stack = readActiveStack(cwd);
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// PreToolUse-hook decision
// ---------------------------------------------------------------------------

/**
 * EXPERIMENTAL — parked (P3), do NOT auto-wire. The subagent-window tracking is
 * now nesting-safe: a depth-aware STACK (push on dispatch, pop on SubagentStop —
 * see {@link pushActiveAgent}/{@link popActiveAgent}) closes the contract-escape
 * the flat single-slot model allowed under Claude Code v2.1.172 depth-5 nesting
 * (certified in research/prototypes/.../AgentWindowStack.tla). The open signal
 * recognizes BOTH spawn tool names (`Task` and the nested-spawn `Agent`), gated on
 * a resolvable `subagent_type` so a non-spawn call never opens a frame. Still
 * parked because the `effect()` sub-region goal it served was dropped (see
 * research/effect-boundary-design.md, "Why dropped") — the stack is shipped for
 * when active-agent contract enforcement under nesting is wanted on its own.
 *
 * Resolve a spawn tool's `subagent_type` to the compiled agent `.md` to
 * activate, or null when none is found. The DETERMINISTIC open signal that
 * replaces the model-invoked `agent-start`: Claude Code fires `PreToolUse` for
 * the parent's `Task` dispatch (and `SubagentStop` when it returns), so the
 * harness — not the model — brackets the subagent's active window. The name is
 * the last ":"-segment (a `--plugin-dir` subagent_type is namespaced
 * "plugin:name"); searched in `agents/` under the cwd then the plugin root. A
 * path under the cwd is returned relative (readActiveAgent resolves vs cwd); a
 * plugin-root hit is absolute. Returns null on an unknown agent (fail-open: an
 * unresolved subagent is simply not gated, exactly as before agent-start ran).
 */
export function resolveDispatchedAgent(
  subagentType: string,
  cwd: string,
  pluginRoot?: string,
): string | null {
  const name = subagentType.split(":").pop()?.trim();
  if (!name) return null;
  const rel = join("agents", `${name}.md`);
  if (existsSync(resolve(cwd, rel))) return rel;
  if (pluginRoot && existsSync(resolve(pluginRoot, rel))) {
    return resolve(pluginRoot, rel);
  }
  return null;
}

/**
 * The agent `.md` to activate for a `PreToolUse(Task)` event, or null. Pure
 * (reads `tool_input.subagent_type`, resolves via {@link resolveDispatchedAgent}).
 */
export function decideTaskDispatch(
  toolInput: unknown,
  cwd: string,
  pluginRoot?: string,
): string | null {
  const st = (toolInput as { subagent_type?: unknown } | null)?.subagent_type;
  if (typeof st !== "string" || !st) return null;
  return resolveDispatchedAgent(st, cwd, pluginRoot);
}

/**
 * PreToolUse-hook decision. If an agent is active, enforce BOTH deterministic
 * rails its compiled `.md` declares, in order:
 *
 *  1. the tool-contract rail (`tools:`) — allow only listed tools;
 *  2. the purity gate (`vigiles:purity:`) — allow only calls within the declared
 *     effect floor, refining `Bash` by the live `command` (`decidePurityGate`).
 *
 * The first to deny wins, feeding its reason back to the model. With no active
 * agent (or one that declared neither contract), always allow — the rails only
 * constrain agents that opted in.
 */
export function evaluatePreToolUse(
  cwd: string,
  tool: string,
  command?: string,
): PreToolDecision {
  const agentPath = readActiveAgent(cwd);
  if (!agentPath) return { allow: true, message: "" };

  const full = resolve(cwd, agentPath);
  if (!existsSync(full)) return { allow: true, message: "" };

  const md = readFileSync(full, "utf-8");

  // 1) Tool-contract rail — the declared allowlist.
  const rail = decidePreToolUse(parseAgentTools(md), tool);
  if (!rail.allow) return rail;

  // 2) Purity gate — the declared effect floor, refined by the live command.
  //    If an effect boundary is declared, tighten to "pure" outside it and apply
  //    the declared purity (or "unrestricted") inside.
  const purity = parseAgentPurity(md);
  const boundary = hasEffectBoundary(md);
  if (boundary) {
    const effective: PurityLevel = readEffectActive(cwd)
      ? (purity ?? "unrestricted")
      : "pure";
    const gate = decidePurityGate(effective, tool, command, claudeCodeDialect);
    if (!gate.allow) return gate;
  } else if (purity) {
    const gate = decidePurityGate(purity, tool, command, claudeCodeDialect);
    if (!gate.allow) return gate;
  }

  return { allow: true, message: "" };
}
